/**
 * 見出しへ飛ぶ（設計 第9-2節「探す」、第14節の実装順序 5）。
 *
 * **本人側の痛みに直接効く一つ目の道具である**（第2節）——「知りたいことが
 * 書いてある場所を探すだけでも大変」。版面（友人側の痛み）とは別の要求であり、
 * ここで応えるのは**飛び先を選ばせること**だけである。
 *
 * **サイドバーではなく、呼んだときだけ本文の上に重ねる。**理由は三つある。
 *
 * 1. **欲しいのは飛び先であって、地図ではない。**痛みは「どこに書いてあるか
 *    探す」であり、常に目次を見ていたいわけではない。用が済めば消えてよい
 * 2. **本文の幅を奪わない。**長い日本語を通しで読むための版面が本体であり
 *    （第9-1節）、行長は版面の質そのものである。横に居座る UI は、読んでいる
 *    間ずっとその質を削る
 * 3. **「出すかどうか」の設定が要らない。**サイドバーは開閉の状態を持ち、
 *    状態は設定になり、設定は覚えるべき概念になる（第4節の第二優先）。
 *    重ねる形なら、覚えるのは呼び出しのキー一つだけで済む
 *
 * **これは「常設 UI を置かない」（第9節）に反しない。**常設ではなく、呼んだ
 * ときだけ出て、飛んだら消える。画面に何かが居座ることはない。
 *
 * このモジュールは main.ts から**動的に import される。**起動して閲覧するだけの
 * 経路——それが普通の使い方である（第1節）——では、一度も読み込まれない。
 * CSS をここで import しているのも同じ理由である（editor.ts と同じ形）。
 */
import "./outline.css";

/** 一覧に並べる見出し一つ。viewer.ts が markdown-it のトークンから作る。 */
export interface OutlineHeading {
  /** `#` の数（1〜6）。 */
  level: number;
  /** 記法記号を落とした見出しの本文。絞り込みの対象になる。 */
  text: string;
  /** 元ソースの行番号（0 始まり）。飛び先の指定に使う。 */
  line: number;
}

export interface OutlineOptions {
  headings: OutlineHeading[];
  /** いま画面の先頭に見えている行。**開いた瞬間の選択をここに合わせる。** */
  current: number;
  /** 選ばれた見出しの行へ飛ぶ。閉じたあとに呼ばれる。 */
  jump: (line: number) => void;
  /** 閉じたときに、元居た場所へ焦点を戻す。 */
  restore: () => void;
}

let root: HTMLElement | null = null;
let options: OutlineOptions | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLElement | null = null;

/** いま一覧に出ている見出し（絞り込んだ後）と、その中で選んでいる位置。 */
let shown: OutlineHeading[] = [];
let selected = 0;
/** その文書で最も浅い見出しの階層。字下げはここからの差で数える。 */
let baseLevel = 1;

export function isOpen(): boolean {
  return root !== null;
}

export function close(): void {
  if (!root) return;
  root.remove();
  root = null;
  input = null;
  list = null;
  shown = [];
  const restore = options?.restore;
  options = null;
  // **閉じたら焦点を返す。**返さないと、消えた要素に焦点が残ったまま矢印キーが
  // どこにも届かなくなり、利用者からは「操作を受け付けなくなった」ように見える。
  restore?.();
}

export function open(opts: OutlineOptions): void {
  close();
  options = opts;
  baseLevel = opts.headings.reduce((min, h) => Math.min(min, h.level), 6);

  root = document.createElement("div");
  root.className = "gera-outline";
  // 覆いの何も無いところを押したら閉じる。**Esc を知らなくても抜けられること。**
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });
  root.addEventListener("keydown", onKey);

  const box = document.createElement("div");
  box.className = "gera-outline-box";

  input = document.createElement("input");
  input.className = "gera-outline-input";
  input.type = "text";
  input.placeholder = "見出しを絞り込む";
  // IME を通す。日本語の見出しを絞り込むのが主用途なので、ここは必須である。
  input.addEventListener("input", () => {
    selected = 0;
    render();
  });

  list = document.createElement("div");
  list.className = "gera-outline-list";
  list.addEventListener("mousedown", (e) => {
    // click ではなく mousedown で拾う。click を待つと、その前に覆いの mousedown が
    // 走って先に閉じてしまう。
    const item = e.target instanceof Element ? e.target.closest(".gera-outline-item") : null;
    if (!(item instanceof HTMLElement)) return;
    e.preventDefault(); // 入力欄から焦点を奪わせない
    selected = Number(item.dataset.index);
    choose();
  });

  box.append(input, list);
  root.append(box);
  document.body.append(root);

  // **開いた瞬間の選択は、いま読んでいる場所にする。**先頭に置くと、長い文書の
  // 途中で呼んだときに現在地が分からず、毎回そこまで送り直すことになる。
  selected = Math.max(
    0,
    opts.headings.reduce((at, h, i) => (h.line <= opts.current ? i : at), 0),
  );
  render();
  input.focus();
}

/**
 * 絞り込みは**大文字小文字を無視した部分一致**である。
 *
 * **あいまい一致（飛び飛びの文字を拾う方式）にしない。**日本語には語の切れ目が
 * 無く、見出しは漢字が詰まっているので、飛び飛びの一致を許すと**ほとんどの
 * 見出しがほとんどの入力に当たってしまう。**絞り込みの目的は候補を減らすことで
 * あり、順位付けで誤魔化すより、当たらないものを落とすほうが直接効く。
 * 部分一致なら**当たった場所をそのまま太字で示せる**（`.gera-outline-mark`）
 * という利点もある——なぜその行が残っているかが見えることは、それ自体が案内である。
 */
function match(text: string, query: string): number {
  return text.toLowerCase().indexOf(query);
}

function render(): void {
  if (!options || !list || !input) return;
  const query = input.value.trim().toLowerCase();
  shown = query ? options.headings.filter((h) => match(h.text, query) >= 0) : options.headings;

  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "gera-outline-empty";
    empty.textContent = options.headings.length
      ? "一致する見出しがありません"
      : "この文書には見出しがありません";
    list.replaceChildren(empty);
    return;
  }

  selected = Math.min(selected, shown.length - 1);
  const items = shown.map((h, i) => {
    const item = document.createElement("div");
    item.className = "gera-outline-item";
    // 階層は字下げで示す（outline.css）。深さは 6 段までで頭打ちにする。
    item.dataset.depth = String(Math.min(5, Math.max(0, h.level - baseLevel)));
    item.dataset.index = String(i);
    const at = query ? match(h.text, query) : -1;
    if (at < 0) {
      item.textContent = h.text;
    } else {
      const mark = document.createElement("span");
      mark.className = "gera-outline-mark";
      mark.textContent = h.text.slice(at, at + query.length);
      item.append(h.text.slice(0, at), mark, h.text.slice(at + query.length));
    }
    if (i === selected) item.classList.add("gera-outline-selected");
    return item;
  });
  list.replaceChildren(...items);
  items[selected]?.scrollIntoView({ block: "nearest" });
}

function move(step: number): void {
  if (!shown.length) return;
  // 端で止めずに回す。長い文書では末尾の見出しへ行くのに ↑ 一回で済む。
  selected = (selected + step + shown.length) % shown.length;
  render();
}

function choose(): void {
  const heading = shown[selected];
  if (!heading || !options) return;
  const jump = options.jump;
  // **先に閉じる。**飛び先の位置合わせ（viewer.ts の settle）は寸法を測るので、
  // 覆いが載ったままだと測る対象が画面の外にあるかどうかを取り違えうる。
  close();
  jump(heading.line);
}

function onKey(e: KeyboardEvent): void {
  // **変換中の ↑↓ と Enter は IME のものである。**候補を選んでいる最中に
  // 一覧が動いたり閉じたりしてはならない。
  if (e.isComposing) return;
  switch (e.key) {
    case "Escape":
      close();
      break;
    case "ArrowDown":
      move(1);
      break;
    case "ArrowUp":
      move(-1);
      break;
    case "Enter":
      choose();
      break;
    default:
      // 打った文字はそのまま入力欄へ。**握り潰さない**ことで、Mod 付きのキーは
      // window 側の受け口（main.ts）にそのまま届く。
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}
