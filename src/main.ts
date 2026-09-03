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
  initialPath,
  loadSession,
  openExternal,
  pickFileToOpen,
  pickPathToSave,
  readFile,
  saveSession,
  setWindowTitle,
  writeFile,
} from "./host";
import { reportFontResolution } from "./fonts";
// 型だけを取る。**実体は動的 import でしか読まない**ので、起動時の初期チャンクに
// 検索の UI は入らない（下の toggleFind）。
import type { FindMatch } from "./find";

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
 * - それ以外は Rust の `open_external` に渡す。**スキームをここで見ない。**
 *   `http` と `https` だけを通す判断は Rust 側が持っている（第7-4節 (d)）。
 *   同じ判断をこちらにも書くと、**フロントが守っているという誤解**を生む——
 *   webview が乗っ取られれば invoke だけが直接飛ぶので、こちら側の検査は
 *   一つも通らない。**判断の置き場所は一つでなければ、どちらが正かが消える。**
 *   拒まれたぶん（`file:` や別ファイルへの相対リンク。後者は第10節の対象外）は
 *   Rust 側が失敗を返し、それが下の帯に出る
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

  run("リンクを開く操作", () => openExternal(href));
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

/**
 * 編集モードで `line`（0 始まり）を画面の先頭に置く。
 *
 * 隠している間や字の大きさを変えた直後は寸法が古いので、測り直してから寄せる。
 */
function scrollEditorToLine(v: EditorView, line: number): void {
  v.requestMeasure();
  const target = v.state.doc.line(Math.min(line + 1, v.state.doc.lines));
  // cm は ensureEditor が必ず埋める。型の上で null を許しているだけである。
  if (!cm) return;
  v.dispatch({
    effects: cm.EditorView.scrollIntoView(target.from, { y: "start", yMargin: 24 }),
  });
}

/** 編集モードへ入る。閲覧モードで先頭に見えていた行を、そのまま先頭に置く（第9-3節）。 */
async function enterEdit(): Promise<void> {
  const app = appElement();
  const line = shown && scroller ? viewer.topLine(scroller) : 0;
  const v = await ensureEditor(app);
  if (scroller) scroller.hidden = true;
  app.hidden = false;
  mode = "edit";
  scrollEditorToLine(v, line);
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

// ---------------------------------------------------------- 見出しへ飛ぶ

/**
 * いま画面の先頭に見えている行（0 始まり）。**モードによらず同じ意味になる。**
 * 位置を渡し合う手段は行番号ひとつに揃えてある（第9-3節）。
 */
function currentLine(): number {
  if (mode === "view") return shown && scroller ? viewer.topLine(scroller) : 0;
  return view ? editorTopLine(view) : 0;
}

/** 焦点をいまのモードの本体へ返す。閲覧モードは矢印キーを受けるために焦点が要る。 */
function focusCurrent(): void {
  if (mode === "view") scroller?.focus({ preventScroll: true });
  else view?.focus();
}

/**
 * 指定した行を画面の先頭に置く。**閲覧モードでも編集モードでも同じ意味になる**
 * ——アウトラインが飛び先として知っているのは行番号だけである。
 */
function jumpToLine(line: number): void {
  if (mode === "view") {
    // 閲覧モードは `content-visibility: auto` で画面外の高さが推定値なので、
    // 一度寄せただけでは着かない。寄せ直しは viewer.ts の settle が持つ。
    if (scroller && shown) viewer.scrollToLine(scroller, line);
  } else if (view) {
    scrollEditorToLine(view, line);
  }
  focusCurrent();
}

/**
 * 見出しの一覧（第9-2節、第14節の実装順序 5）。`Mod+Shift+O` で出し入れする。
 *
 * **編集モードでも動かす。**「探す」は読むときだけの用ではなく、直す場所へ行くのも
 * 同じ動作である。**受け口を window に置いてあるので**（下の keydown）CodeMirror の
 * keymap と取り合いにならず、`Mod+Shift+O` は CodeMirror の既定に無いので
 * 奪うものも無い。**両モードで同じキーが同じ意味を持つほうが、覚えることが少ない**
 * （第4節の第二優先）。飛び先も、行番号を挟めば両モードで同じ扱いにできる。
 *
 * 一覧は**本文の正**（このファイルの `text`）から作る。編集モードでは打った直後の
 * 本文がまだ描画に反映されていないので、描画済みの DOM を見に行くと古い一覧が出る。
 */
let outline: typeof import("./outline") | null = null;

async function toggleOutline(): Promise<void> {
  const ui = (outline ??= await import("./outline"));
  if (ui.isOpen()) {
    ui.close();
    return;
  }
  ui.open({
    headings: viewer.listHeadings(text),
    current: currentLine(),
    jump: jumpToLine,
    restore: focusCurrent,
  });
}

/**
 * 文書内を検索する（第9-2節、第14節の実装順序 6）。`Mod+F` で出す。
 *
 * **見出し一覧と対になる道具である。**一覧が「章から探す」もの、検索が
 * 「語から探す」もので、どちらも本人側の痛み（第2節）に効く。
 *
 * **見出し一覧と同じく、編集モードでも同じキーが同じ意味を持つ**（第4節の
 * 第二優先）。`Mod+F` は CodeMirror の既定 keymap に無い（`@codemirror/search`
 * を入れていない）ので、window で受けても取り合いにならない。**入れない理由は、
 * 見た目と操作がもう一つ増えるからである**——本文の文字列を探して行番号で飛ぶ
 * という同じ仕組みで、両モードを賄える。
 *
 * 探す対象は**本文の正**（このファイルの `text`）である。編集モードでは打った
 * 直後の本文がまだ描画に反映されておらず、閲覧モードでは画面外のブロックが
 * まだ組まれていない（viewer.ts の EAGER）。**どちらの事情にも巻き込まれない
 * 側を見る**のは、見出し一覧がトークンから見出しを取るのと同じ判断である。
 */
let find: typeof import("./find") | null = null;

/**
 * 当たりへ飛んで見せる。**焦点は検索の入力欄に残したままにする**
 * ——`Enter` を続けて押して次々に送れることが要件だからである
 * （`jumpToLine` は焦点を本体へ返すので、ここでは使わない）。
 */
function showMatch(query: string, at: FindMatch): void {
  if (mode === "view") {
    if (scroller && shown && find) find.showInView(scroller, query);
  } else if (view && cm) {
    // **編集モードでは CodeMirror の選択範囲で示す。**エディタは画面外の行を
    // DOM に持たないので、閲覧モード側の強調（CSS Custom Highlight API）は
    // そのままでは保たない。選択範囲なら本文にも触れず、既にある仕組みで足りる。
    view.dispatch({
      selection: { anchor: at.index, head: at.index + query.length },
      // 当たりは行ではなく点なので、上端に置くより中ほどのほうが前後が見える。
      effects: cm.EditorView.scrollIntoView(at.index, { y: "center" }),
    });
  }
}

async function toggleFind(): Promise<void> {
  const ui = (find ??= await import("./find"));
  // 開いているときの `Mod+F` は、閉じるのではなく**打ち直せる状態に戻す。**
  // ブラウザと同じ振る舞いなので、覚えることが増えない（第4節の第二優先）。
  if (ui.isOpen()) {
    ui.refocus();
    return;
  }
  ui.open({
    text,
    from: currentLine(),
    show: showMatch,
    clear: ui.clearInView,
    restore: focusCurrent,
  });
}

// -------------------------------------------------------------- 字の大きさ

/**
 * 版面の倍率（第9-4節）。
 *
 * **触るのは倍率（`--font-scale`）だけで、基準（`--font-size-view` /
 * `--font-size-edit`）には一切触れない。**基準は利用者 CSS が決める場所である
 * （第9-4節「種類 → ユーザー CSS」）。両方を一つの `font-size` に押し込むと、
 * `Mod 0` が**利用者の決めた基準を消す**操作になる。二つに分けてある限り、
 * `Mod 0` は「利用者が決めた大きさ」に戻るのであって、gera の既定には戻らない。
 *
 * 刻みはブラウザの拡大率（80/90/100/110/125/150…）に合わせた。**利用者が既に
 * 指に入れている段階で、覚えるべき概念が増えない**（第4節の第二優先）。
 * 100% の近傍を 10% 刻みにしてあるのは、これ以上細かいと一段押しても変わった
 * 気がせず何度も押すことになり、これ以上粗いと「ちょっと大きく」が効かない
 * ためである。離れるほど粗くするのは、大きい側では 10% の差が絶対値では
 * 大きいからである。
 *
 * 上下を 67%〜200% で切ってあるのは、既定の 17px に対して 11px〜34px にあたる。
 * これより小さいと日本語の漢字が潰れて読めず、これより大きいと 35em の行長
 * （viewer.css）が画面に収まらなくなって、行長を保つという版面の前提が崩れる。
 */
const SCALES = [0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
/** 等倍の位置。`Mod 0` の戻り先であり、読めない設定が入っていたときの既定でもある。 */
const UNIT = SCALES.indexOf(1);
const SCALE_KEY = "gera:font-scale";

/**
 * 記憶した倍率を読む。**文書の内容ではなく利用者ごとの表示設定**なので、
 * 退避（Rust 側）ではなく localStorage に置く。
 *
 * 読めないこと・壊れていることを普通に起こる事態として扱う。private window では
 * 参照そのものが例外になり、中身は利用者が書き換えられる。**字の大きさごときで
 * 起動を落とさない。**保存してある値そのものではなく最も近い段に寄せるのは、
 * あとで刻みを変えても記憶が無効にならないようにするためである。
 */
function loadScaleIndex(): number {
  let saved: number;
  try {
    saved = Number(localStorage.getItem(SCALE_KEY));
  } catch {
    return UNIT;
  }
  if (!Number.isFinite(saved) || saved <= 0) return UNIT;
  let best = UNIT;
  for (let i = 0; i < SCALES.length; i++) {
    if (Math.abs(SCALES[i]! - saved) < Math.abs(SCALES[best]! - saved)) best = i;
  }
  return best;
}

let scaleIndex = loadScaleIndex();

function applyFontScale(): void {
  document.documentElement.style.setProperty("--font-scale", String(SCALES[scaleIndex] ?? 1));
}

/**
 * 倍率を一段動かす（`step` が 0 なら等倍に戻す）。
 *
 * **変えた瞬間に版面が組み直され、いま読んでいた場所が上下にずれる。**
 * モード切替と同じ手段——行番号を挟んで戻す（第9-3節）——で引き戻す。
 * 常設の指標は置かない（第9節）。代わりに、他に手掛かりが無いので帯に一度だけ出す。
 */
function changeFontScale(step: number): void {
  const next = step === 0 ? UNIT : Math.min(SCALES.length - 1, Math.max(0, scaleIndex + step));
  if (next === scaleIndex) return;
  scaleIndex = next;
  const line = currentLine();
  applyFontScale();
  if (mode === "view") {
    if (scroller && shown) viewer.scrollToLine(scroller, line);
  } else if (view) {
    scrollEditorToLine(view, line);
  }
  try {
    localStorage.setItem(SCALE_KEY, String(SCALES[scaleIndex]));
  } catch {
    // 記憶できなくても、この起動の間は効いている。利用者の操作は成立しているので黙る。
  }
  notify(`文字の大きさ ${Math.round((SCALES[scaleIndex] ?? 1) * 100)}%`);
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

  // 見出しの一覧を出したまま別の操作をしたら、その一覧はもう用済みである
  // （`Mod+Shift+O` 自身だけは、出し入れの切り替えなので通す）。
  if (outline?.isOpen() && !(key === "o" && e.shiftKey)) outline.close();
  // 検索も同じ扱いにする。`Mod+F` 自身だけは通す（開いていれば入力欄へ戻る）。
  if (find?.isOpen() && key !== "f") find.close();

  // 見出しへ飛ぶ（第9-2節）。VS Code の「ファイル内のシンボルへ移動」と同じ綴りに
  // 揃えてある——**既に指に入っている操作なら、覚えることが増えない**（第4節）。
  if (key === "o" && e.shiftKey) {
    e.preventDefault();
    run("見出しの一覧", toggleOutline);
    return;
  }

  // 文書内を検索する（第9-2節）。**preventDefault が要る**——webview に渡すと
  // ブラウザ既定の検索に奪われ、そちらは段階的描画のせいで画面外を見つけられない。
  if (key === "f") {
    e.preventDefault();
    run("文書内検索", toggleFind);
    return;
  }

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
  // 字の大きさ（第9-4節）。**綴りが一つに定まらないので、両方から受ける。**
  // `+` は多くの配列で Shift を伴い、そのとき e.key は配列によって `+` にも `;` にも
  // なる。テンキーは Shift 無しで `+` を出すが e.code が別である。**e.key で意味を、
  // e.code で位置を拾い、どちらかが当たれば通す。**`=` を受けるのは、Shift 無しでも
  // 拡大できるほうが押しやすいためで、ブラウザも同じ扱いをしている。
  if (key === "+" || key === "=" || e.code === "NumpadAdd" || e.code === "Equal") {
    e.preventDefault();
    changeFontScale(1);
    return;
  }
  if (key === "-" || key === "_" || e.code === "NumpadSubtract" || e.code === "Minus") {
    e.preventDefault();
    changeFontScale(-1);
    return;
  }
  if (key === "0" || e.code === "Numpad0") {
    e.preventDefault();
    changeFontScale(0);
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
// 記憶した倍率は、最初に描く前に効かせる。あとから当てると版面を二度組むことになる。
applyFontScale();

/**
 * 着く先を決める。**コマンドライン引数が先で、退避はその次である**（第9-5節）。
 *
 * 引数で指されたファイルは「いま開けと言われたもの」であり、退避は「前回の続き」
 * である。両方あるときに前回を優先する読み方は無い。
 *
 * **中身のある文書なら閲覧モードで見せる。**gera はほとんどビューアーである
 * （第1節）。**この経路では CodeMirror を一度も読まない。**
 *
 * **空のときは編集モードで始める。**空の閲覧モードには表示するものが無く、
 * カーソルも持たない（第9-1節）ので、画面には何も無く、打つこともできない
 * 状態になる。空の文書に対して利用者ができることは「書き始める」か「開く」
 * だけであり、前者は編集モードでしか行えない。
 */
run("起動", async () => {
  const startup = await initialPath();
  if (startup.path) {
    try {
      text = await readFile(startup.path);
      currentPath = startup.path;
      refreshTitle();
      enterView(0);
      return;
    } catch (e) {
      // Rust 側は読めることを確かめてから渡してくるが、その後に消される経路は
      // 残っている。ここで投げ直すと**どのモードにも入らないまま終わり、画面が
      // 白いまま**になる。理由を出して、引数が無かったときと同じ道に落とす。
      notify(`${startup.path} を開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (startup.error) {
    notify(`指定されたファイルを開けませんでした: ${startup.error}`);
  }

  // **引数が開けなかったことは、退避を捨てる理由にならない。**退避はまだファイルに
  // 書いていない本文であり、ここで空の文書を出すと、それが次の退避で上書きされて
  // 消える。**失うものがある側に倒さない**（第9-6節と同じ規則）。
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
