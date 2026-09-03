// `import "./style.css"` の型。vite が `*.css` の宣言をここで持ち込む。
/// <reference types="vite/client" />

/**
 * 起動と、本文の出入り口。設計 第9節の実装順序 1・2。
 *
 * **起動時に読むのは閲覧モードだけである。**gera はほとんどビューアーであり
 * （第1節）、起動して着く先も閲覧モードである。編集モード（CodeMirror）は
 * `Mod+E` を押すか、空の文書で始まったときに初めて読む（このファイルの
 * `ensureEditor`）。逆——閲覧を動的 import にして CodeMirror を初期チャンクに
 * 置く形——だと、**その起動では使わないコードを毎回読むことになる。**
 *
 * したがって本文の正は CodeMirror ではなくこのファイルの `text` が持つ。
 * CodeMirror が居ない起動が普通にあるので、本文の置き場をそちらに預けられない。
 */
import "./style.css";
import * as viewer from "./viewer";
import type { EditorView } from "@codemirror/view";
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

/** 本文の正。CodeMirror が居ない起動があるので、置き場をそちらに預けない。 */
let text = "";
let currentPath: string | null = null;
let dirty = false;
// 退避を読むまでは、どちらのモードに着くかが決まらない。中身のある文書なら閲覧、
// 空なら編集である（このファイル末尾の起動処理）。
let mode: "edit" | "view" = "view";

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
function scheduleStash(latest: string): void {
  window.clearTimeout(stashTimer);
  stashTimer = window.setTimeout(() => {
    void saveSession({ path: currentPath, text: latest }).catch((e: unknown) => {
      // 退避の失敗は利用者の操作に対する応答ではないため、帯は出さず log だけに残す。
      console.error("[gera] 自動退避に失敗", e);
    });
  }, 800);
}

// ------------------------------------------------------------ 編集モードの遅延

/**
 * 編集モード一式（CodeMirror）を読み込み、まだ無ければ作る。
 *
 * **起動時には呼ばない。**呼ぶのは `Mod+E` と、空の文書で始まったときだけである。
 * `@codemirror/view` を名前空間ごと動的に取るのは、`EditorView.scrollIntoView`
 * が実行時の値だからである。`./editor` と同じチャンクに入るので費用は増えない。
 */
let view: EditorView | null = null;
let cm: typeof import("@codemirror/view") | null = null;

async function ensureEditor(app: HTMLElement): Promise<EditorView> {
  if (view) return view;
  const [cmView, editor] = await Promise.all([import("@codemirror/view"), import("./editor")]);
  cm = cmView;
  // 本文を入れると updateListener が走って dirty が立つ。中身を移しただけで
  // 「変更あり」にはしない——保存していない状態かどうかは text 側の履歴で決まる。
  const was = dirty;
  const created = editor.createEditor(app, [], (latest) => {
    text = latest;
    dirty = true;
    refreshTitle();
    scheduleStash(latest);
  });
  if (text) editor.replaceDoc(created, text);
  dirty = was;
  refreshTitle();
  view = created;
  return created;
}

// ------------------------------------------------------------------ コマンド

function appElement(): HTMLElement {
  const app = document.getElementById("app");
  if (!app) throw new Error("#app が無い");
  return app;
}

async function openFile(): Promise<void> {
  const path = await pickFileToOpen();
  if (!path) return; // 取り消しは失敗ではない
  const loaded = await readFile(path);
  text = loaded;
  currentPath = path;
  dirty = false;
  refreshTitle();
  if (view) {
    const editor = await import("./editor");
    editor.replaceDoc(view, loaded);
    // replaceDoc が onChange を同期に呼ぶため、dirty はそのあとで落とす。
    dirty = false;
    refreshTitle();
  }
  // **文書を読み込んだら閲覧モードで見せる**（第1節「ほとんどビューアー」）。
  // 起動時の復元（下）と同じ扱いにする——どの経路で文書が入っても着く先が
  // 同じでなければ、利用者はモードを意識させられる。
  await enterView(0);
}

async function saveFile(forcePicker: boolean): Promise<void> {
  const path = forcePicker || !currentPath ? await pickPathToSave(currentPath) : currentPath;
  if (!path) return;
  await writeFile(path, text);
  // 例外が出なかったときだけ dirty を落とす。失敗を成功として扱わない。
  currentPath = path;
  dirty = false;
  refreshTitle();
}

// ------------------------------------------------------------ モードの切替

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
    if (!scroller) return;
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
function editorTopLine(v: EditorView): number {
  const rect = v.scrollDOM.getBoundingClientRect();
  const pos = v.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 1 }, false);
  return v.state.doc.lineAt(pos).number - 1;
}

/** 器を一度でも画面に出したか。出していなければスクロール位置はまだ 0 である。 */
let shown = false;

/**
 * 閲覧モードへ入る。`line`（0 始まり）を画面の先頭に見せる。
 *
 * **文書を読み込んだ直後もここを通る**（起動時の復元と openFile）。
 */
function enterView(line: number): void {
  const el = viewerElement();
  // 寸法を測ってから位置を合わせるので、描く前に画面へ出しておく。
  el.hidden = false;
  appElement().hidden = true;
  mode = "view";
  // **一度も画面に出していない器は、スクロール位置がまだ 0 である。**
  // `scrollTop` への代入は、値を丸めるために同期のレイアウトを走らせるので、
  // 0 を入れる必要が無いときは触らない。**実測での取り分は小さい**が、
  // やらない理由も無い水準である。
  const fresh = !shown;
  shown = true;
  viewer.renderInto(el, text);
  if (line > 0 || !fresh) viewer.scrollToLine(el, line);
  // focus() は既定で対象を画面内へ送ろうとして寸法を測る。上と同じ理由で止める。
  el.focus({ preventScroll: true });
}

/** 編集モードへ入る。閲覧モードで先頭に見えていた行を、そのまま先頭に置く（第9-3節）。 */
async function enterEdit(): Promise<void> {
  const app = appElement();
  const line = shown && scroller ? viewer.topLine(scroller) : 0;
  const v = await ensureEditor(app);
  if (scroller) scroller.hidden = true;
  app.hidden = false;
  mode = "edit";
  // 隠している間に寸法が古くなっているので、測り直してから位置を合わせる。
  v.requestMeasure();
  const target = v.state.doc.line(Math.min(line + 1, v.state.doc.lines));
  // cm は ensureEditor が必ず埋める。型の上で null を許しているだけである。
  if (cm) {
    v.dispatch({
      effects: cm.EditorView.scrollIntoView(target.from, { y: "start", yMargin: 24 }),
    });
  }
  v.focus();
}

/**
 * モードの切り替え（第5節）。**両方向で、いま見ていた場所が引き続き見えること**を
 * 満たすため、行番号を挟んで位置を渡す。段落と行は一対一でないので一致はしないが、
 * 同じ見出しの近くには戻る。
 */
async function toggleMode(): Promise<void> {
  if (mode === "edit") enterView(view ? editorTopLine(view) : 0);
  else await enterEdit();
}

/**
 * 入出力とモード切替の受け口を、CodeMirror の keymap ではなく window に置く。
 *
 * **閲覧モードには CodeMirror が居ない**——それどころか、閲覧モードだけで
 * 終わる起動では読み込まれてすらいない。両方向を一箇所で受けるほかない。
 * `Mod-` は macOS で Cmd、Linux と Windows で Ctrl（第5節）。
 *
 * ここで受けるのは**入出力とモード切替だけ**である。undo や Backspace は
 * CodeMirror 側の既定 keymap に残す（読み専用のはずの画面から本文が変わらないように）。
 */
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
  const key = e.key.toLowerCase();

  if (key === "e") {
    e.preventDefault();
    run("モードの切り替え", toggleMode);
    return;
  }
  if (key === "o" && !e.shiftKey) {
    e.preventDefault();
    run("ファイルを開く操作", openFile);
    return;
  }
  if (key === "s") {
    e.preventDefault();
    const shift = e.shiftKey;
    run(shift ? "名前を付けて保存" : "保存", () => saveFile(shift));
    return;
  }
  // AI との対話に貼り直すための一括コピー（第11節）。Shift 無しの Mod-c は
  // 選択範囲のコピーなので、webview に渡したまま触らない。
  if (key === "c" && e.shiftKey) {
    e.preventDefault();
    run("クリップボードへの出力", async () => {
      await copyToClipboard(text);
      notify("本文をクリップボードにコピーしました");
    });
  }
});

// -------------------------------------------------------------------- 起動

/**
 * 第5節の要（書体でモードを示す）が成立しているかを測って log に出す。
 *
 * **これは開発者向けの診断であって、利用者の目に入るものは何も作らない。**
 * にもかかわらず、起動時にそのまま呼ぶと**実測で 68 ms を最初の描画の前に払う**
 * （2,204 数式の文書、release ビルド、n=3 で 68/68/69 ms）。中身は 72px の
 * canvas で明朝とゴシックを 8 回測るもので、**その場で両方の書体を読ませて
 * 字形を組ませる**ため、この値になる。
 *
 * **描き終えてから測る。**診断の結果は console にしか出ないので、遅れて出ても
 * 何も損なわれない。requestIdleCallback が無い実装のために setTimeout に落とす。
 */
function reportFontsWhenIdle(): void {
  const idle = (window as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (idle) idle.call(window, reportFontResolution);
  else window.setTimeout(reportFontResolution, 200);
}
reportFontsWhenIdle();

refreshTitle();

/**
 * 退避を読み、着く先を決める。
 *
 * **中身のある文書なら閲覧モードで見せる。**gera はほとんどビューアーである
 * （第1節）。**この経路では CodeMirror を一度も読まない。**
 *
 * **空のときは編集モードで始める。**空の閲覧モードには表示するものが無く、
 * カーソルも持たない（第9-1節）ので、画面には何も無く、打つこともできない
 * 状態になる。空の文書に対して利用者ができることは「書き始める」か「開く」
 * だけであり、前者は編集モードでしか行えない。
 */
run("退避の読み込み", async () => {
  const session = await loadSession();
  if (session?.text) {
    currentPath = session.path;
    text = session.text;
    // 退避は「まだファイルに書いていない状態」の記録なので、dirty は落とさない。
    dirty = true;
    refreshTitle();
    enterView(0);
    return;
  }
  await enterEdit();
});
