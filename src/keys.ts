/**
 * キー操作の一覧（`F1`）。
 *
 * **gera は本文以外の常設 UI を持たない**（設計 第9節）。メニューもツールバーも
 * 無いので、**操作を知る手掛かりが画面に一つも無い。**利用者は本人と友人の
 * 二人で（第3節）、**友人は初めて起動したときに何もできない。**ここで埋めるのは
 * その穴だけである。
 *
 * **`F1` を選んだ理由。**Windows でも Linux でも「ヘルプ」の綴りとして通っており、
 * **既に指に入っている綴りなら、覚えることが増えない**（第4節の第二優先）。
 * `?` は編集モードで文字入力とぶつかるので採れない。修飾キーを伴わないので、
 * gera が既に使っている `Mod+…` のどれとも衝突しない。
 *
 * **これは常設 UI ではない**（第9節）。出るのは三つの形で、いずれも画面に居座らない。
 *
 * 1. **`F1` の覆い**（`open` / `close`）——呼んだときだけ出て、`Esc` か `F1` で消える。
 *    見出しの一覧（outline.ts）と同じ作法である
 * 2. **空の文書のときの控えめな一覧**（`showHint` / `hideHint`）——**表示するものが
 *    無い瞬間にだけ出る。**何か打てば消える。**状態が無ければ画面に何も足さない**
 * 3. **ファイル名の隣の案内**（`.gera-keys-tip`。style.css と main.ts）——**画面の
 *    左上に常に出る。**2026-09-04 に本人の指示で常設にした（第9節を緩める判断。
 *    経緯は main.ts の `refreshFileLabel`）。**唯一の常設 UI がこれである**ので、
 *    2 が出ている間は畳んで、同じことを二度言わないようにしてある（main.ts）
 *
 * **2 を 1 の使い回しにしなかった理由。**覆いは本文の上に重ねて閉じさせる形で、
 * **閉じるまで打てない。**空の文書で利用者ができることは「書き始める」ことなので、
 * **打鍵の邪魔をする形は目的と逆を向く。**中身（下の `GROUPS`）は一つに保ち、
 * **見せ方だけを二つ持つ**——一覧の内容が二箇所に分かれると、片方だけ古くなる。
 *
 * このモジュールは main.ts から**動的に import される。**起動して閲覧するだけの
 * 経路——それが普通の使い方である（第1節）——では一度も読み込まれない。CSS を
 * ここで import しているのも同じ理由である（outline.ts と同じ形）。
 */
import "./keys.css";

/**
 * 修飾キーの綴り。**`Mod` と書いても押せない**ので、その環境で実際に押すものを出す。
 * macOS は `Cmd`、Windows と Linux は `Ctrl`（main.ts の受け口が
 * `metaKey || ctrlKey` で両方を受けているのと対応する）。
 *
 * webview の中なので OS は `userAgent` からしか分からない。**外すと綴りが一つ
 * ずれるだけ**で、操作そのものは両方の修飾キーで通る。
 */
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Cmd" : "Ctrl";

interface Row {
  key: string;
  desc: string;
}

interface Group {
  /** 見出し。`null` は主たる一覧（見出しを付けない）。 */
  title: string | null;
  rows: Row[];
}

/**
 * 載せるもの。**一覧であって説明ではない**ので、一行に収まらない話は書かない
 * （保存の衝突や未保存の扱いは、その場で帯が案内する。main.ts）。
 *
 * 綴りは main.ts の受け口をそのまま写したものである。**主たる一覧のあとに、
 * 道具の中と編集モードを分けてある**——前者は覚えなくても困らないが、
 * 知っていれば速い類のものなので、混ぜると主たる一覧が読みにくくなる。
 */
const GROUPS: Group[] = [
  {
    title: null,
    rows: [
      { key: `${MOD}+O`, desc: "ファイルを開く" },
      { key: `${MOD}+S`, desc: "保存" },
      { key: `${MOD}+Shift+S`, desc: "名前を付けて保存" },
      { key: `${MOD}+R`, desc: "ファイルを読み直す" },
      { key: `${MOD}+E`, desc: "閲覧 ⇄ 編集の切り替え" },
      { key: `${MOD}+Shift+O`, desc: "見出しへ飛ぶ" },
      { key: `${MOD}+F`, desc: "文書内を探す" },
      { key: `${MOD}+ + / − / 0`, desc: "字の大きさ" },
      { key: `${MOD}+,`, desc: "ユーザー CSS を読み直す" },
      { key: `${MOD}+Shift+C`, desc: "本文全体をクリップボードへ" },
      { key: "F1", desc: "この一覧" },
    ],
  },
  {
    title: "見出しの一覧と検索の中で",
    rows: [
      { key: "↑ ↓", desc: "見出しを選ぶ" },
      { key: "Enter", desc: "選んだ見出しへ飛ぶ／次の当たりへ" },
      { key: "Shift+Enter", desc: "前の当たりへ" },
      { key: "Esc", desc: "閉じる" },
    ],
  },
  {
    title: "編集モードで",
    rows: [
      { key: `${MOD}+Z`, desc: "元に戻す" },
      { key: `${MOD}+Shift+Z`, desc: "やり直す" },
    ],
  },
];

/**
 * 一覧そのものを組む。覆いと控えめな一覧で**同じものを使う**（このファイル冒頭）。
 *
 * **群が変わっても格子は一つに保つ。**群ごとに分けると**キーの列の幅が群ごとに
 * 変わり、綴りが縦に揃わない。**揃っていないと、探しているキーを目で追えない
 * （群の見出しは二列ぶんを跨がせる。keys.css）。
 */
function buildList(): HTMLElement {
  const list = document.createElement("div");
  list.className = "gera-keys-list";
  for (const group of GROUPS) {
    if (group.title) {
      const head = document.createElement("div");
      head.className = "gera-keys-group";
      head.textContent = group.title;
      list.append(head);
    }
    for (const row of group.rows) {
      const key = document.createElement("div");
      key.className = "gera-keys-key";
      key.textContent = row.key;
      const desc = document.createElement("div");
      desc.className = "gera-keys-desc";
      desc.textContent = row.desc;
      list.append(key, desc);
    }
  }
  return list;
}

// ------------------------------------------------------------ `F1` の覆い

export interface KeysOptions {
  /** 閉じたときに、元居た場所へ焦点を戻す。 */
  restore: () => void;
}

let root: HTMLElement | null = null;
let options: KeysOptions | null = null;

export function isOpen(): boolean {
  return root !== null;
}

export function close(): void {
  if (!root) return;
  root.remove();
  root = null;
  const restore = options?.restore;
  options = null;
  // **閉じたら焦点を返す。**返さないと、消えた要素に焦点が残ったまま矢印キーが
  // どこにも届かなくなり、利用者からは「操作を受け付けなくなった」ように見える
  // （outline.ts と同じ）。
  restore?.();
}

export function open(opts: KeysOptions): void {
  close();
  options = opts;

  root = document.createElement("div");
  root.className = "gera-keys";
  // 覆いの何も無いところを押したら閉じる。**Esc を知らなくても抜けられること。**
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });
  root.addEventListener("keydown", onKey);

  const box = document.createElement("div");
  box.className = "gera-keys-box";
  // **絞り込む入力欄を持たない**（見出しの一覧と違い、数えるほどしかない）ので、
  // 焦点の受け手が箱そのものになる。焦点が無いと `Esc` と `↑↓` がここに届かない。
  box.tabIndex = -1;
  box.append(buildList());

  root.append(box);
  document.body.append(root);
  box.focus();
}

function onKey(e: KeyboardEvent): void {
  if (e.isComposing) return;
  // `F1` は握り潰さない。**出し入れの切り替えは main.ts の受け口が持つ**ので、
  // ここで閉じると閉じた直後にもう一度開くことになる。
  if (e.key !== "Escape") return;
  close();
  e.preventDefault();
  e.stopPropagation();
}

// -------------------------------------------------- 空の文書のときの一覧

/**
 * 空の文書に、控えめな一覧を出す（このファイル冒頭の 2）。
 *
 * **打鍵の邪魔をしない。**置き先は CodeMirror の本文ではなくスクロールする器
 * （`scrollDOM`）で、そこへの絶対配置である——**本文に差し込むと行の高さの計算が
 * ずれてカーソルの位置が狂う**（keys.css）。`pointer-events` も切ってあるので、
 * 文字の選択も奪わない。
 *
 * **打鍵のたびに呼ばれる**（main.ts の `refreshStatus`）ので、既に出ていれば
 * 何もしない。**同じ値でも DOM に触ると様式の計算をやり直させる**（第5-10節）。
 */
let hint: HTMLElement | null = null;

export function showHint(parent: HTMLElement): void {
  if (hint?.parentNode === parent) return;
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "gera-keys-hint";
    hint.append(buildList());
  }
  parent.append(hint);
}

export function hideHint(): void {
  hint?.remove();
}
