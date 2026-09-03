/**
 * 文書内を検索する（設計 第9-2節、第14節の実装順序 6）。
 *
 * **見出し一覧（outline.ts）と対になる道具である。**一覧が「章から探す」もので
 * あるのに対し、こちらは「語から探す」ものである。本人側の痛み——「知りたいことが
 * 書いてある場所を探すだけでも大変」（第2節）——に効く二つ目の道具にあたる。
 *
 * **一覧と違って、本文の上に重ねない。**検索は**当たった箇所を見ながら**使う
 * 道具であり、本文を覆うと目的そのものが消える。したがって入力欄は画面の隅に
 * 小さく出す。**右下に置くのは、飛び先が画面の上端に来るからである**
 * （viewer.ts の MARGIN）——上に出すと、いま当たった箇所を自分で隠すことになる。
 *
 * **常設ではない。**`Mod+F` で出て `Esc` で消える。第9節の「常設 UI を置かない」に
 * 反しないのは一覧と同じ理由である。
 *
 * **検索するのは DOM ではなく本文の文字列である。**閲覧モードは段階的に描画し
 * （viewer.ts の EAGER と IntersectionObserver）、`content-visibility: auto` も
 * 掛かっているので、**画面の外は「そこに在るが組まれていない」状態がありうる。**
 * `innerText` を舐める実装は文書の大半を取りこぼし、ブラウザ既定の `Ctrl+F` が
 * 使えないのもこれが理由である。一覧が見出しをトークンから取っているのと同じ
 * 考え方で、**描画の進み具合に一切依存しない側**——main.ts が持つ本文——を見る。
 *
 * **閲覧モード側の強調（このファイル後半）もここに置く。**viewer.ts に置くと、
 * 閲覧モードは起動時に読む側なので**検索を一度も使わない起動でも運ぶ荷物**に
 * なる。起動速度が第一優先である以上（第4節）、検索のために払う費用は
 * `Mod+F` を押した人だけが払う形にする。
 *
 * このモジュールは main.ts から**動的に import される。**`Mod+F` を押すまで
 * 読み込まれない（CSS も同様）。outline.ts と同じ形である。
 */
import { scrollToLine } from "./viewer";
import "./find.css";

/** 当たり一つ。行番号は閲覧モードの飛び先、位置は編集モードの選択範囲に使う。 */
export interface FindMatch {
  /** 元ソースの行番号（0 始まり）。 */
  line: number;
  /** 本文の先頭から数えた位置（文字数）。 */
  index: number;
}

export interface FindOptions {
  /** 本文の正（main.ts の `text`）。**これを検索する。** */
  text: string;
  /** 検索を始める行。**最初の当たりはここから後ろで探す。** */
  from: number;
  /** いま選んでいる当たりへ飛んで見せる。`query` は強調の綴りとして要る。 */
  show(query: string, match: FindMatch): void;
  /** 強調を消す。閉じたときに呼ばれる。 */
  clear(): void;
  /** 閉じたときに、元居た場所へ焦点を戻す。 */
  restore(): void;
}

let root: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let counter: HTMLElement | null = null;
let options: FindOptions | null = null;

/** いまの当たりの一覧と、その中で選んでいる位置。 */
let matches: FindMatch[] = [];
let current = 0;
/** 語を打ち直したときに「ここから後ろ」で探し始める行。飛ぶたびに付いてくる。 */
let anchor = 0;

/** 各行の開始位置。当たりの位置から行番号を引くのに使う（open のたびに作る）。 */
let lineStarts: number[] = [];
/** 大文字小文字を畳んだ本文。打鍵のたびに畳み直さないよう憶えておく。 */
let folded = "";

/**
 * **畳むのは大文字小文字だけである。**全角と半角、ひらがなとカタカナは
 * 別の文字として扱う。理由は二つある。
 *
 * 1. **位置がずれる。**`NFKC` のような正規化は文字数を変える（`ﾊﾞ` の 2 文字が
 *    `バ` の 1 文字になる）。畳んだ文字列で見つけた位置は元の本文の位置と
 *    一致しなくなり、**飛び先も強調も一つずつ狂う。**元に戻す対応表を持てば
 *    直せるが、それは検索一つに持たせる仕掛けとしては重すぎる（第4節の第二優先）
 * 2. **予測しにくくなる。**「カタカナで打ったのにひらがなに当たる」は、当たって
 *    嬉しい場面と、絞り込みたいのに絞り込めない場面が半々である。**賢くするほど、
 *    なぜその件数になったのかが説明できなくなる**
 *
 * 大文字小文字だけは畳む。`Enter` と `enter` を別物として扱う理由が無く、
 * 英数字の綴りを正確に思い出せないことは日本語の文書でも普通に起きる。
 */
const fold = (s: string): string => s.toLowerCase();

/**
 * 検索に使う「畳んだ本文」と「畳んだ語」を決める。
 *
 * **`toLowerCase` は稀に文字数を変える**（`İ` は `i̇` の 2 文字になる）。長さが
 * 変わると畳んだ側で見つけた位置が元の本文と対応しなくなるので、そのときだけ
 * **大文字小文字の区別を諦めて生のまま探す。**黙って一つ隣へ飛ぶより、
 * 当たらないほうが利用者に見える。
 */
function prepare(query: string): { hay: string; needle: string } {
  const text = options?.text ?? "";
  const needle = fold(query);
  if (folded.length === text.length && needle.length === query.length) return { hay: folded, needle };
  return { hay: text, needle: query };
}

/**
 * 本文から当たりを全部集める。
 *
 * **記法記号を落とさず、生の Markdown をそのまま探す。**`**強調**` を探すと
 * `**` にも当たり、`$x^2$` は綴りのまま当たる。それでもこちらを採るのは、
 *
 * - **編集モードで見えているのは、まさにこの文字列である。**両モードで同じキーが
 *   同じ意味を持つことが要件であり（第9-2節）、片方だけ別の文字列を探していたら
 *   件数が食い違う
 * - **行番号との対応が壊れない。**記法を落とした本文を別に組み立てると、その
 *   位置から元の行へ戻す対応表が要る。表がずれれば飛び先が狂い、**ずれても
 *   気付けない**（第5節の教訓と同じで、静かに間違うものを増やさない）
 * - **予測できる。**打った文字がファイルの中にあればそこに当たる、という規則は
 *   grep と同じで、説明も要らない（第4節の第二優先）
 *
 * 失うのは、記法をまたぐ語に当たらないこと（`**強調**され` の「強調され」）だけで
 * ある。**画面上の綴りに合わせるほうが正しく見える場面はあるが、その正しさは
 * 対応表の正しさに乗っており、こちらのほうが壊れにくい。**
 */
function search(query: string): FindMatch[] {
  const { hay, needle } = prepare(query);
  const found: FindMatch[] = [];
  if (!needle) return found;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    found.push({ line: lineOf(at), index: at });
  }
  return found;
}

/** 位置から行番号（0 始まり）を引く。行頭の一覧を二分探索する。 */
function lineOf(index: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function isOpen(): boolean {
  return root !== null;
}

export function close(): void {
  if (!root) return;
  window.removeEventListener("keydown", onWindowKey);
  root.remove();
  root = null;
  input = null;
  counter = null;
  matches = [];
  const done = options;
  options = null;
  folded = "";
  lineStarts = [];
  // **閉じても、最後に飛んだ場所に留まる。**探して着いた先が消えるなら、
  // 探した意味が無い。ここでするのは強調を消すことと焦点を返すことだけである。
  done?.clear();
  done?.restore();
}

/** 開いたまま `Mod+F` をもう一度押されたとき。ブラウザと同じく、打ち直せる状態に戻す。 */
export function refocus(): void {
  input?.focus();
  input?.select();
}

export function open(opts: FindOptions): void {
  close();
  options = opts;
  anchor = opts.from;
  folded = fold(opts.text);
  lineStarts = [0];
  for (let at = opts.text.indexOf("\n"); at >= 0; at = opts.text.indexOf("\n", at + 1)) {
    lineStarts.push(at + 1);
  }

  root = document.createElement("div");
  root.className = "gera-find";
  root.addEventListener("keydown", onKey);

  input = document.createElement("input");
  input.className = "gera-find-input";
  input.type = "text";
  input.placeholder = "文書内を検索";
  // IME を通す。日本語を探すのが主用途なので、ここは必須である。変換中に走らせない
  // 手当ては onKey ではなくこちら側にも要る（下の isComposing）。
  input.addEventListener("input", (e) => {
    // **変換中の未確定文字では検索しない。**「けんさく」と打っている途中の
    // 「k」「け」「けん」で飛び回ると、確定する前に読んでいた場所を失う。
    if ((e as InputEvent).isComposing) return;
    update();
  });
  // 変換が確定した瞬間に一度だけ走らせる。上で弾いたぶんをここで拾う。
  input.addEventListener("compositionend", () => update());

  counter = document.createElement("span");
  counter.className = "gera-find-count";

  root.append(input, counter);
  document.body.append(root);
  window.addEventListener("keydown", onWindowKey);
  input.focus();
}

/**
 * 語が変わったので探し直す。**検索を始めた場所から後ろで最初の当たり**を選ぶ。
 * 先頭から選ぶと、長い文書の途中で呼んだときに毎回冒頭へ飛ばされる（見出し一覧が
 * 開いた瞬間の選択を現在地に合わせているのと同じ理由）。
 */
function update(): void {
  if (!input) return;
  matches = search(input.value);
  const at = matches.findIndex((m) => m.line >= anchor);
  current = at < 0 ? 0 : at;
  render();
}

/** いま選んでいる当たりを見せ、件数を出す。 */
function render(): void {
  if (!options || !input || !counter) return;
  // 飛んだ先を次の起点にする。**一字足したときに、いま見ている場所から探し直す**
  // ためで、起点を開いた場所に固定すると、絞り込むたびに冒頭へ引き戻される。
  anchor = matches[current]?.line ?? anchor;

  if (!input.value || !matches.length) {
    // 語が空のときは何も言わない。**打つ前から「見つかりません」と出るのは、
    // 利用者が何もしていないのに失敗を告げることになる。**
    counter.textContent = input.value ? "見つかりません" : "";
    counter.classList.toggle("gera-find-none", Boolean(input.value));
    options.clear();
    return;
  }
  // **何件目か・全部で何件かを出す。**これが無いと「もっとあるのか、これで
  // 最後か」が分からず、Enter を押し続けるほかなくなる。
  counter.textContent = `${current + 1} / ${matches.length}`;
  counter.classList.remove("gera-find-none");
  options.show(input.value, matches[current] as FindMatch);
}

/** 次（`step` が 1）か前（-1）の当たりへ。端では回す——一覧の `move` と同じ作法。 */
function move(step: number): void {
  if (!matches.length) return;
  current = (current + step + matches.length) % matches.length;
  render();
}

/**
 * 本文の側に焦点が移ったあとでも `Esc` で閉じられるようにする。
 *
 * **入力欄は覆いを持たない**（本文を隠さないため）ので、利用者が本文を触った
 * 瞬間に焦点は出ていく。そのとき下の `onKey` は届かず、**閉じ方が無くなる。**
 * 焦点が入力欄にあるうちは `onKey` が先に止める（stopPropagation）ので、
 * ここが二重に走ることはない。
 */
function onWindowKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && !e.isComposing) close();
}

function onKey(e: KeyboardEvent): void {
  // **変換中の Enter は IME のものである。**候補を確定している最中に次の当たりへ
  // 飛んではならない（見出し一覧の onKey と同じ）。
  if (e.isComposing) return;
  switch (e.key) {
    case "Escape":
      close();
      break;
    case "Enter":
      move(e.shiftKey ? -1 : 1);
      break;
    default:
      // 打った文字はそのまま入力欄へ。**握り潰さない**ことで、Mod 付きのキーは
      // window 側の受け口（main.ts）にそのまま届く。
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// ---------------------------------------------------------- 当たりの強調

/**
 * 閲覧モードで、当たりに色を付けて飛ぶ。
 *
 * **本文の DOM を書き換えない**（CSS Custom Highlight API）。`<mark>` で包むと
 * `data-line` の対応（第6節）も `renderFragment` によるブロックの差し替え
 * （局所編集）も、包んだぶんだけ形が変わって壊れる。**強調は見た目の層だけで
 * 完結させる。**API が無い実装では強調だけを諦める——飛ぶことは成立するので、
 * 道具として死にはしない。
 *
 * **色を付けるのは、いま画面に入っているブロックだけである。**これは節約では
 * なく、**そうしないと壊れるからである**（下の `watch`）。
 */
const ALL = "gera-find";
const CURRENT = "gera-find-current";

const highlights: HighlightRegistry | undefined =
  typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : undefined;

/** 見出しの着地点と同じだけ上端から下げる（viewer.ts の MARGIN と同じ値）。 */
const MARGIN = 24;

/** 当たりを含むブロックと、そこに属する当たりの添字（`matches` の中での位置）。 */
let groups = new Map<HTMLElement, number[]>();
/** そのうち、いま画面に入っているもの。**色を付けてよいのはここだけである。** */
let onScreen = new Set<HTMLElement>();
let watching: IntersectionObserver | null = null;
/** 飛んだ直後だけ、当たりが画面に入っているかを確かめて寄せ直す。 */
let wantNudge = false;
let scrollerNow: HTMLElement | null = null;
let queryNow = "";

export function clearInView(): void {
  watching?.disconnect();
  watching = null;
  groups = new Map();
  onScreen = new Set();
  scrollerNow = null;
  queryNow = "";
  highlights?.delete(ALL);
  highlights?.delete(CURRENT);
}

/** `lines`（各ブロックの開始行）から、その行を含むブロックの添字を引く。無ければ -1。 */
function blockAt(lines: number[], line: number): number {
  if (!lines.length || (lines[0] ?? 0) > line) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lines[mid] ?? 0) <= line) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * ブロック一つの中で、当たりの範囲を集める。
 *
 * **文字の節（テキストノード）を直に読む。**`nodeValue` は
 * `content-visibility: auto` でまだ組まれていないブロックでも読めるので、
 * **描画の進み具合に依存しない**（`innerText` は依存する）。
 *
 * 節をまたぐ当たりは拾えない——`**強調**` は `<strong>` で節が切れるので、
 * 「強調」には当たるが「強調され」には当たらない。**これは検索そのものの性質と
 * 揃っている**（上の `search` は記法記号を落とさない生の本文を探すので、
 * 「強調され」はそもそも当たりに数えない）。
 */
function rangesIn(block: HTMLElement, query: string): Range[] {
  const lower = fold(query);
  // 畳んで長さが変わる綴りでは位置が対応しない。そのときは生のまま探す（prepare と同じ判断）。
  const caseless = lower.length === query.length;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const found: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = node.nodeValue ?? "";
    const low = fold(data);
    const usable = caseless && low.length === data.length;
    const hay = usable ? low : data;
    const needle = usable ? lower : query;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      found.push(range);
    }
  }
  return found;
}

/**
 * いま画面に入っているブロックぶんの強調を作り直す。
 *
 * **画面外のブロックの範囲を混ぜてはならない。**実測（WebKitGTK 2.52、
 * 2026-09-03）——`content-visibility: auto` で中身を飛ばされたブロックの中に
 * 作った Range は、**そのブロック全体を覆う帯**として、しかも**画面の中の
 * 無関係なブロックの上に**塗られる。範囲そのものは正しい（`toString()` は
 * 「検索」を返す）ので、**位置を出す側が組まれていない中身を測れないため**である。
 * 見た目だけの問題では済まない——当たっていない段落が丸ごと色付くので、
 * **どこが当たりなのかが読めなくなる。**
 *
 * 画面に入っているブロックは必ず組まれているので、そこだけを塗れば起きない。
 * 出入りは IntersectionObserver で追う（viewer.ts の fillMath と同じ作法）。
 */
function repaint(): void {
  if (!highlights) return;
  const all = new Highlight();
  let target: Range | null = null;
  for (const block of onScreen) {
    const list = groups.get(block);
    if (!list) continue;
    const found = rangesIn(block, queryNow);
    for (const range of found) all.add(range);
    const nth = list.indexOf(current);
    if (nth >= 0) target = found[Math.min(nth, found.length - 1)] ?? null;
  }
  highlights.set(ALL, all);
  if (target) {
    const one = new Highlight(target);
    // 重なった部分は、選んでいる一件の色で塗る。
    one.priority = 1;
    highlights.set(CURRENT, one);
  } else {
    // 選んでいる一件が画面の外にあるなら、その色も消す（上と同じ理由）。
    highlights.delete(CURRENT);
  }
  if (wantNudge && target && scrollerNow) {
    wantNudge = false;
    nudge(scrollerNow, target);
  }
}

/**
 * 当たりを含むブロックを見つけ、その出入りを監視する。語が変わったときだけ組み直す。
 */
function watch(scroller: HTMLElement, doc: HTMLElement, query: string): void {
  watching?.disconnect();
  groups = new Map();
  onScreen = new Set();
  scrollerNow = scroller;
  queryNow = query;

  const blocks: HTMLElement[] = [];
  const lines: number[] = [];
  // **数えるのは `.gera-doc` の直下だけである。**content-visibility が働く単位も
  // 行の対応もここに在る（viewer.ts）。
  for (const child of doc.children) {
    const el = child as HTMLElement;
    // **包みには行が付いていないことがある。**表は `.gera-table` で包んであり、
    // 行を持つのは中の `<table>` である。包みごと落とすと、**表の中の当たりが
    // 一つも強調されない。**
    const own = el.dataset.line ?? el.querySelector<HTMLElement>("[data-line]")?.dataset.line;
    const line = Number(own);
    if (own !== undefined && Number.isFinite(line)) {
      blocks.push(el);
      lines.push(line);
    }
  }

  // 当たりをブロックごとにまとめる。**行から引くので、画面外でも取りこぼさない。**
  for (let i = 0; i < matches.length; i++) {
    const at = blockAt(lines, matches[i]?.line ?? 0);
    const block = at < 0 ? undefined : blocks[at];
    if (!block) continue;
    const list = groups.get(block);
    if (list) list.push(i);
    else groups.set(block, [i]);
  }

  watching = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const block = entry.target as HTMLElement;
        if (entry.isIntersecting) onScreen.add(block);
        else onScreen.delete(block);
      }
      repaint();
    },
    // **余白を取らない。**画面に入っているブロックだけが「組まれている」と
    // 言い切れる範囲であり、先回りするとそこが崩れる（repaint の注記）。
    { root: scroller },
  );
  for (const block of groups.keys()) watching.observe(block);
}

/**
 * 当たりそのものが画面に入っていなければ寄せる。
 *
 * **ブロックの先頭へ寄せるだけでは足りない。**長い箇条書きやコードブロックでは、
 * ブロックの頭が上端に来ても当たりは画面の下にありうる。
 */
function nudge(scroller: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect();
  if (!rect.height) return;
  const top = scroller.getBoundingClientRect().top;
  if (rect.top >= top && rect.bottom <= top + scroller.clientHeight) return;
  scroller.scrollTop += rect.top - top - MARGIN;
}

/** 閲覧モードで当たりへ飛び、色を付ける。飛び先が未描画のブロックでも着く。 */
export function showInView(scroller: HTMLElement, query: string): void {
  const at = matches[current];
  if (!at) {
    clearInView();
    return;
  }
  const doc = scroller.querySelector<HTMLElement>(".gera-doc");
  // 語が変わったときだけ組み直す。次の当たりへ送るだけなら、監視はそのまま使える。
  if (doc && (query !== queryNow || scroller !== scrollerNow)) watch(scroller, doc, query);
  // 飛ぶのは viewer.ts に任せる。**未描画のブロックでも着く経路はそこにしかない**
  // （content-visibility の推定を実寸に置き換えながら寄せ直す settle）。
  scrollToLine(scroller, at.line);
  wantNudge = true;
  // **寄せ直しが済んでから塗り直す。**飛び先のブロックが画面に入ったことを
  // 監視が知るのは次のフレームの描画手前なので、その後ろに回す（viewer.ts の
  // settle と同じ形）。監視の側からも repaint は呼ばれるので、どちらが先でも
  // 最後には同じ状態に落ち着く。
  requestAnimationFrame(() => {
    requestAnimationFrame(repaint);
  });
}
