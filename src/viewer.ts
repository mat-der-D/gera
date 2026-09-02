/**
 * 閲覧モード（設計 第4節・第9節の実装順序 2）。
 *
 * **このアプリの本体はここである。**主用途は AI が出力した Markdown を読むことであり
 * （第2節）、編集はその延長にある。したがってこのファイルが受け持つのは
 * 「3000 字超の日本語を通しで読み通せる版面」を出すことである。
 *
 * このモジュールは main.ts から動的 import される。markdown-it と DOMPurify と KaTeX を
 * 起動時のバンドルに載せないためで、起動速度が第一優先である以上（第3節）、
 * 起動時に編集モードしか要らない依存を読ませない。CSS をここで import
 * しているのも同じ理由——閲覧モードに入るまで読み込まれない。
 *
 * 数式の遅延読み込みをこれ以上細かくしない（第5-6節）。KaTeX 一式を読む費用は
 * 約 100 ms で、**閲覧モードごと後回しにする**この形で既にその大半を避けている。
 * 「数式が無い文書のときだけ KaTeX を読まない」は、得る 0.1 秒に対して
 * 分岐と状態が増えすぎる（第4節の第二優先）。
 */
import MarkdownIt from "markdown-it";
import type { Env, MarkdownIt as MarkdownItInstance, Token } from "markdown-it";
import DOMPurify from "dompurify";
import katexModule from "@vscode/markdown-it-katex";
// KaTeX の CSS とフォントは node_modules から取り込んで成果物に同梱する。
// CSP が外部を許していない（第7-2節）ので CDN は使えない。viewer.css より先に
// 置くのは、同じ強さの規則ならこちらの版面が後勝ちで上書きできるようにするため。
//
// **katex を package.json の直接の依存に持ち、上のプラグインが要求する版に
// 合わせてあるのは、この行のためである。**版がずれると KaTeX の copy が二つ入り、
// 描くのはプラグイン側の版・当てる CSS はこちらの版になる。組の名前は版をまたいで
// 変わるので、**食い違ったまま気付けない。**
import "katex/dist/katex.min.css";
import "./viewer.css";

// このパッケージは CJS のまま公開されており、`exports.__esModule` と `exports.default`
// を同時に持つ。ESM 側から読むと default が「関数」ではなく「exports そのもの」に
// なる処理系があり、そのまま md.use に渡すと `apply is not a function` で落ちる。
// 型の上では関数なので、実物を見て両方の形を受ける。
const katexPlugin =
  (katexModule as unknown as { default?: typeof katexModule }).default ?? katexModule;

/**
 * ブロック要素に元ソースの行範囲を埋める。
 *
 * これが閲覧モードと生ソースを結ぶ唯一の手掛かりであり、三つの用途を同時に支える。
 * 一つ目は、モードを切り替えたときに同じ場所が見えていること（第5節）。
 * 二つ目は、後から足すブロック単位の局所編集——**開始行だけでは足りず、
 * どこまでがそのブロックかが要る**ので終了行も出す。三つ目は、読解補助
 * （アウトライン等）が DOM から見出しと位置を引けること。
 *
 * markdown-it の block token は `map` に [開始行, 終了行) を 0 始まりで持つ。
 * 終端は排他のまま流す——加工すると、使う側が元の意味を確かめられなくなる。
 */
const lineNumbers = (md: MarkdownItInstance): void => {
  md.core.ruler.push("gera_line_numbers", (state) => {
    for (const token of state.tokens) {
      // 閉じタグ（nesting -1）には属性が出ないので付けない。
      if (!token.map || token.nesting < 0) continue;
      token.attrSet("data-line", String(token.map[0]));
      token.attrSet("data-line-end", String(token.map[1]));
    }
    return true;
  });
};

/**
 * 見出しに id を振る。同一文書内のジャンプ（第9-1節）の着地点になる。
 *
 * 規則は GitHub と VS Code に合わせる——小文字にし、ASCII の記号を落とし、
 * 空白を `-` にする。**合わせる理由は、AI が書く目次が GitHub の綴りで
 * リンクを張ってくるからである。**自分だけの綴りを発明すると、渡された文書の
 * 目次がそのまま死ぬ。日本語はそのまま残す（GitHub もそうする）。
 */
const slug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[!-/:-@[-`{-~]/g, "")
    .replace(/\s+/g, "-");

const headingIds = (md: MarkdownItInstance): void => {
  md.core.ruler.push("gera_heading_ids", (state) => {
    // 同じ見出しが二度出たら GitHub と同じく連番を足す。id が重なると
    // ジャンプ先が常に先頭の一つになり、後ろの章へ飛べなくなる。
    const used = new Map<string, number>();
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length - 1; i++) {
      const open = tokens[i];
      const inline = tokens[i + 1];
      if (!open || open.type !== "heading_open") continue;
      if (!inline || inline.type !== "inline") continue;
      const base = slug(inline.content) || "section";
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      open.attrSet("id", n === 0 ? base : `${base}-${n}`);
    }
    return true;
  });
};

/**
 * GFM のタスクリスト。
 *
 * markdown-it 本体は表・取り消し線・自動リンクを持つが、タスクリストだけ持たない。
 * このためだけにプラグインを一つ増やすより、`[ ] ` で始まる箇条書きの先頭を
 * checkbox に差し替えるだけで足りる。読み専用なので disabled で固定する。
 */
const taskLists = (md: MarkdownItInstance): void => {
  md.core.ruler.push("gera_task_lists", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      const paragraph = tokens[i - 1];
      const item = tokens[i - 2];
      if (!inline || inline.type !== "inline") continue;
      if (!paragraph || paragraph.type !== "paragraph_open") continue;
      if (!item || item.type !== "list_item_open") continue;

      const marker = /^\[([ xX])\]\s+/.exec(inline.content);
      if (!marker) continue;
      const text = inline.children?.[0];
      if (!text || text.type !== "text") continue;

      const checked = marker[1] !== " ";
      item.attrJoin("class", "gera-task");
      const box = new state.Token("html_inline", "", 0);
      box.content = `<input type="checkbox" disabled${checked ? " checked" : ""}> `;
      inline.children?.unshift(box);
      text.content = text.content.slice(marker[0].length);
      inline.content = inline.content.slice(marker[0].length);
    }
    return true;
  });
};

// ------------------------------------------------------------------ 数式

/**
 * KaTeX の出力を sanitize の外に出すための預かり場所。
 *
 * **sanitize は「文書から来た HTML」のためのものである**（第7-4節 (b)）。
 * KaTeX の出力はこちらが `trust: false` で生成した自前の HTML で、しかも
 * inline style と `<svg>`（`\sqrt` や大きい括弧）に依存している——文書向けの
 * 許可リストは両方を落とすので、そのまま通せば数式は壊れる。
 * **許可リストをゆるめるのではなく、こちらの生成物を最初から通さない。**
 * 変換時には目印だけを置き、sanitize が済んでから実物に差し戻す。
 */
interface MathEnv extends Env {
  math?: string[];
}

const SLOT = /<span data-math="(\d+)"><\/span>/g;

function slot(env: MathEnv, html: string): string {
  const math = (env.math ??= []);
  return `<span data-math="${math.push(html) - 1}"></span>`;
}

/**
 * KaTeX のプラグインが出した HTML を目印に置き換える。
 *
 * 併せてブロック数式を `.gera-math` で包み、行番号を持たせる。プラグインの
 * 出力は `<p class="katex-block">` だけで data-line を持たないため、包まないと
 * **175 個ある別行立ての数式が、モード切り替えの位置合わせから丸ごと抜ける。**
 */
const mathSlots = (md: MarkdownItInstance): void => {
  const rules = md.renderer.rules;

  const capture = (name: string, wrap: (token: Token, html: string) => string): void => {
    const inner = rules[name];
    if (!inner) return;
    rules[name] = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (!token) return "";
      // \label は KaTeX が解釈できず、**その数式が丸ごと消えて英語のエラー文が
      // 本文に出る。**ただし本人の数式文書に \label は 1 個も入っておらず
      // （第5-5節）、これは必要な処置ではなく**ほぼ無料の保険**である。
      token.content = token.content.replace(/\\label\s*\{[^}]*\}/g, "");
      return slot(env ?? {}, wrap(token, inner(tokens, idx, options, env, self)));
    };
  };

  capture("math_inline", (_token, html) => html);
  capture("math_inline_block", (_token, html) => html);
  capture("math_inline_bare_block", (_token, html) => html);
  capture("math_block", (token, html) => {
    const map = token.map ? ` data-line="${token.map[0]}" data-line-end="${token.map[1]}"` : "";
    return `<div class="gera-math"${map}>${html}</div>`;
  });
};

const md = new MarkdownIt({
  // 第7節: `html: false` にすると AI 出力に頻出する <details> や <br> が
  // 生テキストで出てしまい査読の役に立たない。**表現力は落とさず、
  // 安全性は下の sanitize で確保する。**
  html: true,
  linkify: true, // GFM の自動リンク
  typographer: false, // 日本語では引用符の置換が邪魔にしかならない
})
  .use(lineNumbers)
  .use(headingIds)
  .use(taskLists)
  .use(katexPlugin, {
    // 既定の "htmlAndMathml" は HTML と MathML の両方を出すが、下の sanitize は
    // MathML を落とす。**既定のままだと捨てる DOM を毎回生成することになる。**
    // 支配的な費用はレイアウトなので（第5-4節）、ノードを減らすことがそのまま効く。
    output: "html",
    // `trust` は既定の false のまま**変えない**ことが要件である（第7-4節 (c)）。
    // \href{javascript:...} と \includegraphics を封じるため、ここに書き残す。
    trust: false,
    // 例外は上げさせない。1 個の数式の誤りで文書全体が出ないほうが困る。
    // プラグインは失敗した数式を .katex-error に置き換えて先へ進む。
    throwOnError: false,
  })
  .use(mathSlots);

/**
 * 表だけを横スクロールさせるための包み。
 *
 * AI 出力の表は横に長くなりがちで、そのままだと本文全体が横スクロールする。
 * 本文の行頭が動くと読めなくなるため、はみ出しは表の中に閉じ込める。
 */
md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
  `<div class="gera-table">${self.renderToken(tokens, idx, options)}`;
md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`;

/**
 * 描画前の sanitize（第7節、必須）。
 *
 * AI 出力の HTML をそのまま webview に流すと、`<script>` ひとつで host.ts が
 * Rust に開けた read_file / write_file に到達する。**描画経路はそのまま攻撃面である。**
 *
 * 許可リスト方式に寄せる（第7-4節 (b)）。**`data-*` を丸ごと通すのをやめ、
 * こちらが意味を決めている三つだけを名指しで通す。**知らない属性は既定で
 * 落ちる側に倒しておく。
 * 落とすものを明示しているのは既定の許可が広いからで、
 * - `style` 要素と style 属性は、こちらが組んだ版面を文書側から壊せてしまう
 * - `target` は「どこで開くか」という挙動の注入であり、本文の表現には要らない
 */
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true }, // SVG と MathML は通さない
    ALLOW_DATA_ATTR: false,
    // data-line / data-line-end は生ソースとの対応（第6節）、
    // data-math は sanitize 後に数式を差し戻す目印（上の MathEnv）。
    ADD_ATTR: ["data-line", "data-line-end", "data-math"],
    FORBID_TAGS: ["style", "form"],
    FORBID_ATTR: ["style", "target"],
  });
}

let lastText: string | null = null;
let body: HTMLElement | null = null;

/**
 * Markdown の断片一つを HTML にする。全文と同じ変換器・同じ sanitize を通る。
 *
 * ブロック単位の局所編集で、直したブロックだけを描き直すためのもの。
 * 全文の描画と経路を分けない——分ければ、そこだけ sanitize を通し忘れうる。
 */
export function renderFragment(markdown: string): string {
  const env: MathEnv = {};
  const html = sanitize(md.render(markdown, env));
  const math = env.math;
  if (!math) return html; // 数式が一つも無ければ差し戻しも要らない
  return html.replace(SLOT, (_all, i: string) => math[Number(i)] ?? "");
}

/**
 * 本文を描き直す。
 *
 * 同じ本文なら何もしない。閲覧と編集を往復するのが普通の使い方で、
 * その大半では本文が変わっていない（第3節の動作速度）。
 * 描画先の要素はこの関数が作って持つ——閲覧モードの DOM の形を知っているのは
 * ここだけでよく、呼ぶ側には器を渡すだけで済む。
 */
export function renderInto(scroller: HTMLElement, text: string): void {
  if (!body || body.parentElement !== scroller) {
    scroller.replaceChildren();
    body = document.createElement("article");
    body.className = "gera-doc";
    scroller.append(body);
    lastText = null;
  }
  if (text === lastText) return;
  lastText = text;
  // トップレベルのブロックが .gera-doc の直下に平らに並ぶ。ブロック一つを
  // replaceWith で入れ替えても壊れない形にしておく（局所編集のため）。
  body.innerHTML = renderFragment(text);
}

// ------------------------------------------------------------ 位置合わせ

/** 見出しが上端に貼り付くと窮屈なので、寄せる先を少しだけ下げる。 */
const MARGIN = 24;

/**
 * 目的の要素が上端に来るまで、寄せては測り直す。
 *
 * **一度では着かない。**viewer.css の `content-visibility: auto` により画面外の
 * 要素は `contain-intrinsic-size` の推定値の高さで置かれているので、寄せた先で
 * 本物の高さが確定し、そのぶん目的の要素がずれる。寄せ直すたびに推定は
 * 本物に置き換わっていくので数回で収まる。**回数を切ってあるのは、末尾付近など
 * これ以上スクロールできない場所では誤差が残り続けて止まらないためである。**
 */
function settle(scroller: HTMLElement, target: HTMLElement): void {
  for (let i = 0; i < 8; i++) {
    const offset =
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - MARGIN;
    if (Math.abs(offset) < 1) return;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + offset;
    if (scroller.scrollTop === before) return; // 端に着いた
  }
}

/** 画面の上端にいちばん近い、行番号を持つ要素。無ければ null。 */
function topElement(scroller: HTMLElement): HTMLElement | null {
  const top = scroller.getBoundingClientRect().top;
  let best: HTMLElement | null = null;
  // 入れ子の内側ほど後に来るため、条件を満たす最後の要素が最も細かい対応になる。
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-line]")) {
    if (el.getBoundingClientRect().top - top > 1) break;
    best = el;
  }
  return best;
}

/** いま画面の先頭に見えている本文の行番号（0 始まり）。 */
export function topLine(scroller: HTMLElement): number {
  const el = topElement(scroller);
  return el ? Number(el.dataset.line) : 0;
}

/**
 * 指定した行が画面の先頭に来るようにスクロールする。
 *
 * 行と要素は一対一ではない（一つの段落が何行にもなる）ため、
 * **その行を含むか、その行より前で最も後ろにある要素**に寄せる。
 */
export function scrollToLine(scroller: HTMLElement, line: number): void {
  // 先頭に戻すだけなら測らない。**測った瞬間に文書全体のレイアウトが同期に走り、
  // content-visibility が後回しにするはずだった画面外の仕事まで先に払う**ことになる。
  // 実測（2,204 数式の文書）で、初回フレームまでが 797 ms → 946 ms に伸びた。
  // 文書を開いた直後はいつもこの経路なので、ここだけで効く。
  if (line <= 0) {
    scroller.scrollTop = 0;
    return;
  }
  let target: HTMLElement | null = null;
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-line]")) {
    if (Number(el.dataset.line) > line) break;
    target = el;
  }
  if (!target) {
    scroller.scrollTop = 0;
    return;
  }
  settle(scroller, target);
}

/**
 * 同一文書内の見出しへ飛ぶ（第9-1節）。見出しが無ければ false を返す。
 *
 * 見つからなかったことを呼ぶ側に返すのは、**黙って何も起きないのが一番悪い**
 * からである（リンクを踏んだのに画面が動かない理由が利用者に分からない）。
 */
export function scrollToAnchor(scroller: HTMLElement, id: string): boolean {
  // id は文書由来なので、そのまま繋ぐと CSS のセレクタとして壊れうる。
  const target = scroller.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!target) return false;
  settle(scroller, target);
  return true;
}
