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
 *    the moment when there is nothing to display, and says only what can be done
 *    there (`EMPTY_ROWS`). Typing anything dismisses it. With no state, nothing is
 *    added to the screen
 * 3. The tip next to the file name (`.gera-keys-tip`; style.css and main.ts) —
 *    always present at the top left of the screen. Made permanent on 2026-09-04 at
 *    the owner's instruction (a decision that relaxes §9; the background is in
 *    `refreshFileLabel` in main.ts). It is the only permanent UI, so while 2 is
 *    showing it folds away, to avoid saying the same thing twice (main.ts)
 *
 * Why 2 is not a reuse of 1. The overlay layers over the text and demands to be
 * closed: you cannot type until it is gone. What a user can do with an empty document
 * is start writing, so a form that gets in the way of keystrokes points away from the
 * purpose.
 *
 * 1 and 2 also say different things. Until 2026-09-08 they shared one content
 * (`SECTIONS`) and differed only in presentation, on the reasoning that a list split
 * across two places would leave one of them stale. Held against the state 2 actually
 * appears in, that turned out to be the wrong saving: nearly every row of `SECTIONS`
 * acts on a document, and 2 is shown precisely when there is none. The owner's
 * decision: 「目的が違って内容も違うので、別管理が良いと思います。」 So 2 has its own
 * content now (`EMPTY_ROWS`, at the bottom of this file) — two rows, the way in and
 * the way to everything else. Going stale is a real cost, and the guard against it is
 * that `EMPTY_ROWS` names no operation that `SECTIONS` does not also carry.
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

/**
 * One item of `Row.keys`: a single cap, or a chord of caps drawn with `+` between
 * them. The nested form exists for rows that are alternatives *of chords* —
 * `Pg Up / Ctrl + ↑ / K` — where the outer separator is `/` and the inner one is `+`.
 * Writing such a chord as one string (`"Ctrl+↑ / K"`) would draw `Ctrl` inside the same
 * keycap as the keys it modifies, and every other row on the list draws it as its own
 * cap, faint (`.gera-keys-mod`). The list is read by shape, so one row spelling a
 * modifier differently is a row that has to be parsed (the owner's correction,
 * 2026-09-08).
 */
type Cap = string | string[];

interface Row {
  /**
   * The spellings, one keycap per entry. `["Ctrl", "Shift", "S"]` is a chord, drawn
   * with `+` between the caps; with `alt` it is a set of alternatives, drawn with `/`.
   * An item may itself be a chord (`["Pg Up", ["Ctrl", "↑"]]` with `alt`).
   * They are split rather than kept as one string so the caps can be drawn as caps:
   * `Ctrl+ + / − / 0` as running text cannot be read for where one key ends.
   */
  keys: Cap[];
  /** The caps are alternatives (`/`), not a chord (`+`). */
  alt?: boolean;
  desc: string;
  /** The second half of a description. Shown fainter, on its own line. */
  note?: string;
  /** `閲覧モード` / `編集モード` — shown as a small tag after the description. */
  only?: string;
  /**
   * The keys that exist only while this row's tool is open, drawn directly beneath
   * it. Hanging them off the row rather than off the section is what puts them in
   * the order they are pressed: `Mod+Shift+O`, then what to press while the outline
   * list is up, then `Mod+F`, then what to press while the search box is up (the
   * owner's ordering, 2026-09-08).
   */
  inner?: Inner;
}

/** Keys that only exist while a tool is open. Nested under the row that opens it. */
interface Inner {
  title: string;
  rows: Row[];
}

interface Section {
  /** What the reader wants to do. See the head of `SECTIONS`. */
  title: string;
  rows: Row[];
}

/**
 * What goes on the list. This is a list, not documentation, so anything that does
 * not fit on one line is left out (save conflicts and the handling of unsaved work
 * are announced by the banner at the moment they happen; main.ts).
 *
 * The spellings are copied straight from the handlers in main.ts and editor.ts.
 *
 * The sections are grouped by what the reader wants to do, not by how gera is put
 * together (§9-14). Sorting by "does it work in both modes" or "what does it change" is
 * true of gera but not of the person opening the list: what they have is 「保存したい」
 * 「先へ進みたい」「さっきの見出しに戻りたい」. So the mode is not a section any more —
 * where it matters it is a tag on the row (`only`), which after §9-13 is four rows in
 * the whole list.
 *
 * The five titles themselves were given by the owner on 2026-09-08, after a round of
 * proposals on the Japanese wording. They are not all verbs (「ファイル操作」「編集する」):
 * the grouping is by intent, and how each group is spelled was the owner's call.
 *
 * Two consequences of grouping this way, both intended:
 *
 * - The tracker sits under 読む, not among the tools. It is a reading operation;
 *   the earlier list had it next to `Mod+F` because both are "things gera provides"
 * - The keys inside a tool sit under the row that opens them (`Row.inner`), so `Mod+F`
 *   and the `Enter` / `Shift+Enter` that follow it are read in the order they are
 *   pressed. They hang off the row, not off the section, so 探す reads straight down:
 *   `Mod+Shift+O` → the outline list's keys → `Mod+F` → the search box's keys
 */
const SECTIONS: Section[] = [
  {
    title: "ファイル操作",
    rows: [
      { keys: [MOD, "O"], desc: "開く" },
      { keys: [MOD, "S"], desc: "上書き保存" },
      { keys: [MOD, "Shift", "S"], desc: "名前を付けて保存" },
      { keys: [MOD, "R"], desc: "再読み込み" },
      { keys: [MOD, "Shift", "C"], desc: "本文全体をコピー" },
    ],
  },
  {
    title: "読む",
    rows: [
      // The caveat is about the bare letters: `Mod+J` / `Mod+K` are bound in both modes
      // (`pageBy` in editor.ts), so the paging rows below carry none.
      { keys: ["↑", "K"], alt: true, desc: "一行戻る", note: "K は閲覧モードのみ" },
      { keys: ["↓", "J"], alt: true, desc: "一行進む", note: "J は閲覧モードのみ" },
      { keys: ["Pg Up", [MOD, "↑ / K"]], alt: true, desc: "一画面戻る" },
      { keys: ["Pg Dn", [MOD, "↓ / J"]], alt: true, desc: "一画面進む" },
      { keys: [MOD, "L"], desc: "トラッカー表示/非表示", only: "閲覧モード" },
      { keys: ["Shift", "↑ / K"], desc: "トラッカーを戻す", only: "閲覧モード" },
      { keys: ["Shift", "↓ / J"], desc: "トラッカーを進める", only: "閲覧モード" },
    ],
  },
  {
    title: "探す",
    rows: [
      {
        keys: [MOD, "Shift", "O"],
        desc: "見出し一覧を表示",
        inner: {
          title: "見出し一覧",
          rows: [
            { keys: ["↑", "↓"], alt: true, desc: "見出しを選ぶ" },
            { keys: ["Enter"], desc: "その見出しへ飛ぶ" },
            { keys: ["Esc"], desc: "閉じる" },
          ],
        },
      },
      {
        keys: [MOD, "F"],
        desc: "文書内を検索",
        inner: {
          title: "検索",
          rows: [
            { keys: ["Enter"], desc: "次の一致へ" },
            { keys: ["Shift", "Enter"], desc: "前の一致へ" },
            { keys: ["Esc"], desc: "閉じる" },
          ],
        },
      },
    ],
  },
  {
    title: "画面を変える",
    rows: [
      { keys: [MOD, "E"], desc: "閲覧 ⇄ 編集の切り替え" },
      { keys: [MOD, "+ / − / 0"], desc: "字の大きさの変更" },
      { keys: [MOD, ","], desc: "ユーザー CSS を再読み込み" },
    ],
  },
  {
    title: "編集する",
    rows: [
      { keys: [MOD, "Z"], desc: "元に戻す", only: "編集モード" },
      { keys: [MOD, "Shift", "Z"], desc: "やり直す", only: "編集モード" },
    ],
  },
];

/** Whether this cap is a modifier. Modifiers are drawn fainter — what is pressed for
 * meaning is the last cap, and the modifiers are how it is reached. */
const MODIFIER = /^(Ctrl|Cmd|Shift|Alt)$/;

/** One keycap. Modifiers are drawn fainter (see `MODIFIER`). */
function buildCap(spelling: string): HTMLElement {
  const cap = document.createElement("span");
  cap.className = MODIFIER.test(spelling) ? "gera-keys-cap gera-keys-mod" : "gera-keys-cap";
  cap.textContent = spelling;
  return cap;
}

/** The `+` between the caps of a chord, or the `/` between alternatives. */
function buildSep(text: string): HTMLElement {
  const sep = document.createElement("span");
  sep.className = "gera-keys-sep";
  sep.textContent = text;
  return sep;
}

/** One row: the caps on the left, what it does on the right. */
function buildRow(row: Row): HTMLElement {
  const el = document.createElement("div");
  el.className = "gera-keys-row";

  const keys = document.createElement("div");
  keys.className = "gera-keys-key";
  // Every item is boxed, with its own leading separator inside the box. The cell can
  // then wrap without a separator ever being left dangling at the end of a line, and
  // without a chord being split from the modifier that belongs to it: the only place a
  // line can break is between two items.
  row.keys.forEach((item, i) => {
    const box = document.createElement("span");
    box.className = "gera-keys-item";
    if (i > 0) box.append(buildSep(row.alt ? "/" : "+"));
    for (const [j, spelling] of (typeof item === "string" ? [item] : item).entries()) {
      if (j > 0) box.append(buildSep("+"));
      box.append(buildCap(spelling));
    }
    keys.append(box);
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

/** The block of keys that exist only while one row's tool is open. */
function buildInner(inner: Inner): HTMLElement {
  const box = document.createElement("div");
  box.className = "gera-keys-inner";

  const title = document.createElement("div");
  title.className = "gera-keys-sub";
  title.textContent = inner.title;
  box.append(title);

  for (const row of inner.rows) box.append(buildRow(row));
  return box;
}

/**
 * The heading of the list itself, shown above the sections in both forms.
 *
 * Added on 2026-09-08 at the owner's instruction. It replaces the row that used to
 * read `F1 — この一覧`: a row inside the list saying how the list is summoned is one
 * of the entries you have to read past, whereas the same thing said in the heading is
 * read by anyone who looks at the list at all. Naming the key here also gives the
 * overlay's own way out, which no row carried before (`Esc` closes it too, but `F1` is
 * the one already in the fingers).
 *
 * It is built as a sibling of `.gera-keys-list`, not inside it: the list is a
 * two-column fragmenter (`columns: 2`; keys.css), and a heading placed in it would be
 * laid out as part of that flow.
 */
function buildHead(): HTMLElement {
  const head = document.createElement("div");
  head.className = "gera-keys-head";

  const title = document.createElement("span");
  title.className = "gera-keys-title";
  title.textContent = "キー操作一覧";

  const how = document.createElement("span");
  how.className = "gera-keys-how";
  const cap = document.createElement("span");
  cap.className = "gera-keys-cap";
  cap.textContent = "F1";
  how.append(cap, " で開く・閉じる");

  head.append(title, how);
  return head;
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
    for (const row of section.rows) {
      el.append(buildRow(row));
      if (row.inner) el.append(buildInner(row.inner));
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
  box.append(buildHead(), buildList());

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
 * What the quiet list on an empty document says. Kept apart from `SECTIONS` at the
 * owner's decision (2026-09-08): "目的が違って内容も違うので、別管理が良い."
 *
 * The state it appears in is narrow. `text` is empty and the mode is edit, which in
 * practice means gera was launched with no argument — the friend's first launch (§3).
 * Almost nothing on `SECTIONS` can be done there: counted against the state, seventeen
 * of its twenty rows act on a document that does not exist yet, and the three tracker
 * rows are view-mode only while this state is edit mode. A first launch met by a
 * screen of keys that do nothing is a bad first screen.
 *
 * So this list is not a shortened copy of `SECTIONS`. It answers the only question
 * open at that moment — how do I get a document in, and where is everything else.
 *
 * `保存` is deliberately absent, though someone who starts typing here will want it:
 * the list is gone by then. It disappears on the first keystroke, so it can only ever
 * be read *before* anything is typed, and a key that is only useful afterwards cannot
 * be read when it is needed. It is on the `F1` list.
 */
const EMPTY_ROWS: Row[] = [
  { keys: [MOD, "O"], desc: "ファイルを開く" },
  { keys: ["F1"], desc: "キー操作一覧" },
];

/**
 * Shows the quiet list on an empty document (form 2 at the head of this file).
 *
 * There is no heading here, unlike the overlay: with two rows there is nothing for a
 * heading to gather, and `F1` is a row of its own — in this state it is a key you
 * would actually press, not a note about how the thing you are reading was summoned.
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
    const list = document.createElement("div");
    list.className = "gera-keys-list";
    for (const row of EMPTY_ROWS) list.append(buildRow(row));
    hint.append(list);
  }
  parent.append(hint);
}

export function hideHint(): void {
  hint?.remove();
}
