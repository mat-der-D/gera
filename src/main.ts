// `import "./style.css"` の型。vite が `*.css` の宣言をここで持ち込む。
/// <reference types="vite/client" />

/**
 * 起動と、本文の出入り口。設計 第9節の実装順序 1・2。
 *
 * カーソル行を生に戻す規則（順序 3）はまだ無い。
 *
 * 状態はモジュールスコープの二つの変数だけで持つ。状態管理の層は置かない
 * （第7節「持つ状態は 4 つだけである」／第3節「覚えるべき概念が少ないこと」）。
 */
import "./style.css";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import type { Command } from "@codemirror/view";
import { createEditor, replaceDoc } from "./editor";
import {
  copyToClipboard,
  loadSession,
  pickFileToOpen,
  pickPathToSave,
  readFile,
  saveSession,
  setWindowTitle,
  writeFile,
} from "./host";
import { reportFontResolution } from "./fonts";

let currentPath: string | null = null;
let dirty = false;
let mode: "edit" | "view" = "edit";

// ---------------------------------------------------------------- 失敗の通知

/**
 * 常設 UI を持たない（第5節）ため、失敗を出す先が画面に無い。
 *
 * console には必ず出したうえで、数秒で消える帯を画面下部に出す。
 * 常設しない・本文に触れない・面積を奪わないので、第5節には反しない。
 * 帯に出すのは、画面に現れない結果だけである。保存の成功はタイトルバーの中黒が
 * 消えることで既に見えているから黙る。クリップボードへの出力は成功しても画面が
 * 何も変わらないため、黙ると動いたかどうかが利用者に分からない。
 */
let noticeTimer: number | undefined;

function notify(message: string): void {
  let bar = document.getElementById("notice");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "notice";
    // style.css は地色と書体だけを受け持つ（同ファイル冒頭）ので、
    // 一時的なこの要素の見た目はここに置く。色は変数を借りて本文から浮かせない。
    bar.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:1.5rem",
      "transform:translateX(-50%)",
      "max-width:36em",
      "padding:0.5em 1em",
      "font:0.85rem/1.6 var(--font-sans)",
      "color:var(--dim)",
      "background:var(--code-bg)",
      "border:1px solid var(--rule)",
      "border-radius:4px",
      "pointer-events:none",
      "white-space:pre-wrap",
    ].join(";");
    document.body.append(bar);
  }
  bar.textContent = message;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => bar.remove(), 5000);
}

/** 非同期の処理を投げっぱなしにしない。握り潰すと、保存の失敗が成功に見える。 */
function run(what: string, task: () => Promise<void>): void {
  void task().catch((e: unknown) => {
    console.error(`[gera] ${what}に失敗`, e);
    notify(`${what}に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/**
 * キーバインド用。ハンドラは同期に `true` を返してデフォルト動作を止める必要がある
 * 一方、中身はすべて非同期なので、待たずに `run` へ預けて即座に `true` を返す。
 */
function command(what: string, task: (view: EditorView) => Promise<void>): Command {
  return (view) => {
    run(what, () => task(view));
    return true;
  };
}

// ------------------------------------------------------------ タイトルと退避

/** パス区切りは配布先の Windows を考慮して両方で切る（第1節）。 */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

let lastTitle: string | null = null;

/**
 * dirty の印は先頭の中黒だけにする。
 * タイトルバーは OS の領分なので、状態表示をここに逃がせる（host.ts の setWindowTitle）。
 *
 * setWindowTitle は Rust への IPC を一往復する。この関数は打鍵のたびに——IME の
 * 変換中は一文字を確定する前にも何度も——呼ばれるが、タイトルは currentPath と
 * dirty からしか決まらず、その大半では変わらない。だから最後に送った文字列を憶えて
 * おき、実際に変わったときだけ送る。
 */
function refreshTitle(): void {
  const name = currentPath ? baseName(currentPath) : "無題";
  const title = `${dirty ? "• " : ""}${name} — gera`;
  if (title === lastTitle) return;
  lastTitle = title;
  run("タイトルの更新", () => setWindowTitle(title));
}

let stashTimer: number | undefined;

/**
 * 不可視の自動退避（第11節）。落ちて全部消える経路を塞ぐためだけのもので、
 * 成否は UI に出さない。打鍵のたびに書かないよう、静まってから一度だけ走らせる。
 */
function scheduleStash(text: string): void {
  window.clearTimeout(stashTimer);
  stashTimer = window.setTimeout(() => {
    void saveSession({ path: currentPath, text }).catch((e: unknown) => {
      // 退避の失敗は利用者の操作に対する応答ではないため、帯は出さず log だけに残す。
      console.error("[gera] 自動退避に失敗", e);
    });
  }, 800);
}

// ------------------------------------------------------------------ コマンド

async function openFile(view: EditorView): Promise<void> {
  const path = await pickFileToOpen();
  if (!path) return; // 取り消しは失敗ではない
  const text = await readFile(path);
  replaceDoc(view, text);
  // replaceDoc が onChange を同期に呼ぶため、dirty はそのあとで落とす。
  currentPath = path;
  dirty = false;
  refreshTitle();
}

async function saveFile(view: EditorView, forcePicker: boolean): Promise<void> {
  const path = forcePicker || !currentPath ? await pickPathToSave(currentPath) : currentPath;
  if (!path) return;
  await writeFile(path, view.state.doc.toString());
  // 例外が出なかったときだけ dirty を落とす。失敗を成功として扱わない。
  currentPath = path;
  dirty = false;
  refreshTitle();
}

// `Mod-` は macOS で Cmd、Linux と Windows で Ctrl に解決される（第5節）。
const commands = keymap.of([
  { key: "Mod-o", run: command("ファイルを開く操作", (view) => openFile(view)) },
  { key: "Mod-s", run: command("保存", (view) => saveFile(view, false)) },
  { key: "Mod-Shift-s", run: command("名前を付けて保存", (view) => saveFile(view, true)) },
  {
    // AI との対話に貼り直すための一括コピー（第11節）。
    key: "Mod-Shift-c",
    run: command("クリップボードへの出力", async (view) => {
      await copyToClipboard(view.state.doc.toString());
      notify("本文をクリップボードにコピーしました");
    }),
  },
]);

// ------------------------------------------------------------ モードの切替

/**
 * 閲覧モードの実体は、初めて切り替えたときに読み込む（第3節の起動速度）。
 * markdown-it と DOMPurify を起動時のバンドルに載せないための動的 import であり、
 * 一度読んだら憶えておく。
 */
let viewer: typeof import("./viewer") | null = null;
let scroller: HTMLElement | null = null;

/**
 * リンクの行き先で振る舞いを分ける（第7-4節 (d)、第9-1節）。
 *
 * どの行き先でも、まず遷移そのものは止める。webview がそのまま外部サイトへ
 * 移ると本文もアプリも画面から消え、戻る手段が無いからである。そのうえで、
 *
 * - `#…` は同一文書内の見出しへ送る
 * - `http` と `https` は OS の既定ブラウザへ渡したい。**が、その経路が Rust 側に
 *   無い**——capability はファイル入出力とダイアログとクリップボードだけで、
 *   opener に当たる権限が入っていない。**踏めないことを黙るのが一番悪い**ので、
 *   URL をクリップボードに渡してそう言う
 * - それ以外（`file:` や別ファイルへの相対リンク）は**何もしない。**前者は
 *   渡さないことが要件そのもの（第7-4節 (d)）、後者は初版の対象外（第10節）で、
 *   どちらも「押しても動かない」が正しい振る舞いである
 */
function onLinkClick(e: MouseEvent): void {
  const link = e.target instanceof Element ? e.target.closest("a") : null;
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute("href");
  if (!href) return;

  if (href.startsWith("#")) {
    // 見出しの id は文書の綴りそのままなので、URL としての符号化を解いてから渡す。
    const id = decodeURIComponent(href.slice(1));
    if (!viewer || !scroller) return;
    if (!viewer.scrollToAnchor(scroller, id)) notify(`この文書に見出し「${id}」がありません`);
    return;
  }

  if (!/^https?:\/\//i.test(href)) return;
  run("リンクの取り出し", async () => {
    await copyToClipboard(href);
    notify(`リンクはこの画面では開けません。URL をクリップボードにコピーしました:\n${href}`);
  });
}

function viewerElement(): HTMLElement {
  if (scroller) return scroller;
  const el = document.createElement("div");
  el.className = "gera-view";
  // 閲覧モードはカーソルを持たない（第4節）ため、そのままでは矢印や PageDown を
  // 受ける相手が画面に居ない。フォーカスを取れるようにして、送りは webview に任せる。
  el.tabIndex = 0;
  el.addEventListener("click", onLinkClick);
  document.body.append(el);
  scroller = el;
  return el;
}

/** 編集モードで画面の先頭に見えている行（0 始まり。閲覧側の data-line と揃える）。 */
function editorTopLine(): number {
  const rect = view.scrollDOM.getBoundingClientRect();
  const pos = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 1 }, false);
  return view.state.doc.lineAt(pos).number - 1;
}

/**
 * モードの切り替え（第5節）。**両方向で、いま見ていた場所が引き続き見えること**を
 * 満たすため、行番号を挟んで位置を渡す。段落と行は一対一でないので一致はしないが、
 * 同じ見出しの近くには戻る。
 */
async function toggleMode(): Promise<void> {
  const app = viewerElement().ownerDocument.getElementById("app");
  if (!app) return;

  if (mode === "edit") {
    const module = (viewer ??= await import("./viewer"));
    const line = editorTopLine();
    const el = viewerElement();
    // 寸法を測ってから位置を合わせるので、描く前に画面へ出しておく。
    el.hidden = false;
    app.hidden = true;
    mode = "view";
    module.renderInto(el, view.state.doc.toString());
    module.scrollToLine(el, line);
    el.focus();
    return;
  }

  const el = viewerElement();
  const line = viewer ? viewer.topLine(el) : 0;
  el.hidden = true;
  app.hidden = false;
  mode = "edit";
  // 隠している間に寸法が古くなっているので、測り直してから位置を合わせる。
  view.requestMeasure();
  const target = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
  view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "start", yMargin: 24 }) });
  view.focus();
}

/**
 * 切り替えの受け口を CodeMirror の keymap ではなく window に置くのは、
 * **閲覧モードには CodeMirror が居ない**からである。両方向を一箇所で受ける。
 * `Mod-` は macOS で Cmd、Linux と Windows で Ctrl（第5節）。
 */
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "e" && !e.isComposing) {
    e.preventDefault();
    run("モードの切り替え", toggleMode);
    return;
  }
  // 閲覧モードでも、開く・保存・コピーは使えるべきである。CodeMirror がフォーカスを
  // 持たないので keymap は自分では走らない。**入出力のキーだけ**を明示して通す
  // （undo や Backspace まで通すと、読み専用のはずの画面から本文が変わる）。
  if (mode !== "view" || !(e.metaKey || e.ctrlKey)) return;
  if (!"osc".includes(e.key.toLowerCase())) return;
  if (runScopeHandlers(view, e, "editor")) e.preventDefault();
});

// -------------------------------------------------------------------- 起動

// 第5節の要（書体でモードを示す）が成立しているかを、まず測って log に出す。
reportFontResolution();

const app = document.getElementById("app");
if (!app) throw new Error("#app が無い");

const view = createEditor(app, commands, (text) => {
  dirty = true;
  refreshTitle();
  scheduleStash(text);
});

view.focus();
refreshTitle();

// 退避の復帰は起動後の非同期で行う。読めなくても空の文書で使えるべきなので、
// 画面の生成をこれで待たせない。
run("退避の読み込み", async () => {
  const session = await loadSession();
  if (!session || !session.text) return;
  replaceDoc(view, session.text);
  currentPath = session.path;
  // 退避は「まだファイルに書いていない状態」の記録なので、dirty は落とさない。
  dirty = true;
  refreshTitle();
});

