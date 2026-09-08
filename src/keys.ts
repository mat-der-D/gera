/**
 * The key list (`F1`).
 *
 * gera has no permanent UI other than the text itself (see DESIGN.md §9). There is
 * no menu and no toolbar, so there is not a single clue on screen for how to
 * operate it. The users are the owner and one friend (§3), and the friend can do
 * nothing at all on first launch. This module fills that one hole and nothing more.
 *
 * Why `F1`. On both Windows and Linux it reads as the spelling of "help", and a
 * spelling already in the fingers adds nothing to remember (the second priority in
 * §4). `?` cannot be used: it collides with typing text in edit mode. `F1` carries
 * no modifier key, so it clashes with none of the `Mod+…` bindings gera already uses.
 *
 * This is not a permanent UI (§9). It appears in three forms, none of which settles
 * onto the screen.
 *
 * 1. The `F1` overlay (`open` / `close`) — appears only when called, dismissed with
 *    `Esc` or `F1`. Same manner as the outline list (outline.ts)
 * 2. The quiet list on an empty document (`showHint` / `hideHint`) — appears only at
 *    the moment when there is nothing to display. Typing anything dismisses it. With
 *    no state, nothing is added to the screen
 * 3. The tip next to the file name (`.gera-keys-tip`; style.css and main.ts) —
 *    always present at the top left of the screen. Made permanent on 2026-09-04 at
 *    the owner's instruction (a decision that relaxes §9; the background is in
 *    `refreshFileLabel` in main.ts). It is the only permanent UI, so while 2 is
 *    showing it folds away, to avoid saying the same thing twice (main.ts)
 *
 * Why 2 is not a reuse of 1. The overlay layers over the text and demands to be
 * closed: you cannot type until it is gone. What a user can do with an empty
 * document is start writing, so a form that gets in the way of keystrokes points
 * away from the purpose. The content (`SECTIONS` below) is kept as one, and only the
 * presentation is kept as two — if the list's content were split across two places,
 * one of them would go stale.
 *
 * This module is dynamically imported from main.ts. The path of launching and just
 * reading — which is the ordinary way to use it (§1) — never loads it once. The CSS
 * is imported here for the same reason (the same shape as outline.ts).
 */
import "./keys.css";

/**
 * How the modifier key is spelled. Writing `Mod` gives nothing to press, so show
 * what is actually pressed in this environment: `Cmd` on macOS, `Ctrl` on Windows
 * and Linux (matching the handler in main.ts, which accepts both via
 * `metaKey || ctrlKey`).
 *
 * Inside a webview the OS can only be guessed from `userAgent`. Guessing wrong only
 * shifts one spelling; the operation itself goes through with either modifier.
 */
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Cmd" : "Ctrl";

interface Row {
  /**
   * The spellings, one keycap per entry. `["Ctrl", "Shift", "S"]` is a chord, drawn
   * with `+` between the caps; with `alt` it is a set of alternatives, drawn with `/`.
   * They are split rather than kept as one string so the caps can be drawn as caps:
   * `Ctrl+ + / − / 0` as running text cannot be read for where one key ends.
   */
  keys: string[];
  /** The caps are alternatives (`/`), not a chord (`+`). */
  alt?: boolean;
  desc: string;
  /** The second half of a description. Shown fainter, on its own line. */
  note?: string;
  /** `閲覧モード` / `編集モード` — shown as a small tag after the description. */
  only?: string;
}

/** Keys that only exist while a tool is open. Nested under the tool that opens it. */
interface Inner {
  title: string;
  rows: Row[];
}

interface Section {
  /** What the reader wants to do. See the head of `SECTIONS`. */
  title: string;
  rows: Row[];
  inner?: Inner[];
}

/**
 * What goes on the list. This is a list, not documentation, so anything that does
 * not fit on one line is left out (save conflicts and the handling of unsaved work
 * are announced by the banner at the moment they happen; main.ts).
 *
 * The spellings are copied straight from the handlers in main.ts and editor.ts.
 *
 * The sections are named after what the reader wants to do, not after how gera is put
 * together (§9-14, the owner's choice on 2026-09-08 out of three drafts). Sorting by
 * "does it work in both modes" or "what does it change" is true of gera but not of the
 * person opening the list: what they have is 「保存したい」「先へ進みたい」「さっきの
 * 見出しに戻りたい」. So the mode is not a section any more — where it matters it is a
 * tag on the row (`only`), which after §9-13 is four rows in the whole list.
 *
 * Two consequences of naming the sections this way, both intended:
 *
 * - The tracker sits under 読み進める, not among the tools. It is a reading operation;
 *   the earlier list had it next to `Mod+F` because both are "things gera provides"
 * - The keys inside a tool sit under the tool that opens them (`inner`), so `Mod+F` and
 *   the `Enter` / `Shift+Enter` that follow it are read in the order they are pressed
 */
const SECTIONS: Section[] = [
  {
    title: "ファイルを出し入れする",
    rows: [
      { keys: [MOD, "O"], desc: "ファイルを開く" },
      { keys: [MOD, "S"], desc: "保存" },
      { keys: [MOD, "Shift", "S"], desc: "名前を付けて保存" },
      { keys: [MOD, "R"], desc: "ファイルを読み直す" },
      { keys: [MOD, "Shift", "C"], desc: "本文全体をクリップボードへ" },
    ],
  },
  {
    title: "読み進める",
    rows: [
      { keys: ["↑ ↓", "J K"], alt: true, desc: "一行進む", note: "J K は閲覧モードのみ" },
      {
        keys: ["PageUp", "PageDown"],
        alt: true,
        desc: "一画面進む",
        note: `${MOD}+↑ ↓ / ${MOD}+J K も同じ`,
      },
      { keys: [MOD, "L"], desc: "トラッカー", note: "読んでいる行に帯", only: "閲覧モード" },
      {
        keys: ["Shift", "↑ ↓ / J K"],
        desc: "帯だけ動かす",
        note: "紙面は動かない",
        only: "閲覧モード",
      },
    ],
  },
  {
    title: "見つける",
    rows: [
      { keys: [MOD, "Shift", "O"], desc: "見出しへ飛ぶ" },
      { keys: [MOD, "F"], desc: "文書内を探す" },
    ],
    inner: [
      {
        title: "見出しの一覧を開いている間",
        rows: [
          { keys: ["↑", "↓"], alt: true, desc: "見出しを選ぶ" },
          { keys: ["Enter"], desc: "その見出しへ飛ぶ" },
          { keys: ["Esc"], desc: "閉じる" },
        ],
      },
      {
        title: "検索を開いている間",
        rows: [
          { keys: ["Enter"], desc: "次の当たりへ" },
          { keys: ["Shift", "Enter"], desc: "前の当たりへ" },
          { keys: ["Esc"], desc: "閉じる" },
        ],
      },
    ],
  },
  {
    title: "画面を変える",
    rows: [
      { keys: [MOD, "E"], desc: "閲覧 ⇄ 編集の切り替え" },
      { keys: [MOD, "+ / − / 0"], desc: "字の大きさ" },
      { keys: [MOD, ","], desc: "ユーザー CSS を読み直す" },
      { keys: ["F1"], desc: "この一覧" },
    ],
  },
  {
    title: "書き直す",
    rows: [
      { keys: [MOD, "Z"], desc: "元に戻す", only: "編集モード" },
      { keys: [MOD, "Shift", "Z"], desc: "やり直す", only: "編集モード" },
    ],
  },
];

/** Whether this cap is a modifier. Modifiers are drawn fainter — what is pressed for
 * meaning is the last cap, and the modifiers are how it is reached. */
const MODIFIER = /^(Ctrl|Cmd|Shift|Alt)$/;

/** One row: the caps on the left, what it does on the right. */
function buildRow(row: Row): HTMLElement {
  const el = document.createElement("div");
  el.className = "gera-keys-row";

  const keys = document.createElement("div");
  keys.className = "gera-keys-key";
  row.keys.forEach((spelling, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "gera-keys-sep";
      sep.textContent = row.alt ? "/" : "+";
      keys.append(sep);
    }
    const cap = document.createElement("span");
    cap.className = MODIFIER.test(spelling) ? "gera-keys-cap gera-keys-mod" : "gera-keys-cap";
    cap.textContent = spelling;
    keys.append(cap);
  });

  const desc = document.createElement("div");
  desc.className = "gera-keys-desc";
  desc.append(row.desc);
  if (row.only) {
    const tag = document.createElement("span");
    tag.className = "gera-keys-only";
    tag.textContent = row.only;
    desc.append(tag);
  }
  if (row.note) {
    const note = document.createElement("span");
    note.className = "gera-keys-note";
    note.textContent = row.note;
    desc.append(note);
  }

  el.append(keys, desc);
  return el;
}

/**
 * Builds the list itself. The overlay and the quiet list use the very same one (see
 * the head of this file).
 *
 * The sections are laid out in two columns by CSS (`columns: 2`; keys.css), not by
 * building two containers here. The quiet list on an empty document is bound to the
 * width of the text column and drops to one column there — a DOM built as two columns
 * could not do that, and the two forms have to stay one list (head of this file).
 *
 * Each section is a grid of its own. The earlier list kept one grid across the whole
 * thing so that every spelling lined up vertically; with sections side by side there is
 * no single column to line up in, and alignment inside a section is what the eye uses.
 */
function buildList(): HTMLElement {
  const list = document.createElement("div");
  list.className = "gera-keys-list";
  for (const section of SECTIONS) {
    const el = document.createElement("div");
    el.className = "gera-keys-section";

    const head = document.createElement("div");
    head.className = "gera-keys-group";
    head.textContent = section.title;
    el.append(head);
    for (const row of section.rows) el.append(buildRow(row));

    for (const inner of section.inner ?? []) {
      const box = document.createElement("div");
      box.className = "gera-keys-inner";
      const title = document.createElement("div");
      title.className = "gera-keys-sub";
      title.textContent = inner.title;
      box.append(title);
      for (const row of inner.rows) box.append(buildRow(row));
      el.append(box);
    }

    list.append(el);
  }
  return list;
}

// -------------------------------------------------------- The `F1` overlay

export interface KeysOptions {
  /** On close, return focus to where it was. */
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
  // Return focus on close. Without it, focus stays on an element that is gone, the
  // arrow keys reach nowhere, and to the user it looks as though the app has stopped
  // accepting input (same as outline.ts).
  restore?.();
}

export function open(opts: KeysOptions): void {
  close();
  options = opts;

  root = document.createElement("div");
  root.className = "gera-keys";
  // Pressing an empty part of the overlay closes it: there must be a way out even
  // for someone who does not know about Esc.
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });
  root.addEventListener("keydown", onKey);

  const box = document.createElement("div");
  box.className = "gera-keys-box";
  // There is no filter input here (unlike the outline list, the entries can be
  // counted on one's fingers), so the box itself receives focus. Without focus,
  // `Esc` and `↑↓` never reach this element.
  box.tabIndex = -1;
  box.append(buildList());

  root.append(box);
  document.body.append(root);
  box.focus();
}

function onKey(e: KeyboardEvent): void {
  if (e.isComposing) return;
  // Do not swallow `F1`. The open/close toggle belongs to the handler in main.ts, so
  // closing here would mean reopening immediately after the close.
  if (e.key !== "Escape") return;
  close();
  e.preventDefault();
  e.stopPropagation();
}

// ------------------------------------------- The list on an empty document

/**
 * Shows the quiet list on an empty document (form 2 at the head of this file).
 *
 * It must not get in the way of keystrokes. It is placed not in CodeMirror's content
 * but in the scrolling container (`scrollDOM`), positioned absolutely within it —
 * inserting it into the content would throw off the line-height calculation and put
 * the cursor in the wrong place (keys.css). `pointer-events` is off too, so it does
 * not steal text selection either.
 *
 * It is called on every keystroke (`refreshStatus` in main.ts), so it does nothing
 * if already shown: touching the DOM forces a style recalculation even when the
 * value is unchanged (§5-10).
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
