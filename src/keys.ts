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
 * away from the purpose. The content (`GROUPS` below) is kept as one, and only the
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
  key: string;
  desc: string;
}

interface Group {
  /** The heading. `null` means the main list (which carries no heading). */
  title: string | null;
  rows: Row[];
}

/**
 * What goes on the list. This is a list, not documentation, so anything that does
 * not fit on one line is left out (save conflicts and the handling of unsaved work
 * are announced by the banner at the moment they happen; main.ts).
 *
 * The spellings are copied straight from the handler in main.ts. After the main
 * list, the ones inside the tools and the ones in edit mode are split off — those
 * are the kind you do not suffer for not knowing but are faster for knowing, so
 * mixing them in would make the main list harder to read.
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
 * Builds the list itself. The overlay and the quiet list use the very same one (see
 * the head of this file).
 *
 * One grid is kept across all groups. Splitting the grid per group would make the
 * width of the key column vary from group to group, and the spellings would not line
 * up vertically. Unaligned, the eye cannot track down the key it is looking for (the
 * group heading spans both columns instead; keys.css).
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
