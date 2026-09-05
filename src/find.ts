/**
 * Search within the document (see DESIGN.md §9-2, and step 6 of the implementation
 * order in §14).
 *
 * This is the companion tool to the heading outline (outline.ts). Where the outline
 * is for finding something by chapter, this is for finding it by word. It addresses
 * the second of the author's own pains — "just locating where the thing I want to
 * know is written is hard work" (§2).
 *
 * Unlike the outline, it does not cover the text. Search is a tool you use while
 * looking at the hit, so covering the text would destroy the very purpose. The input
 * field therefore appears small, in a corner of the screen. It sits at the bottom
 * right because the jump target lands at the top edge of the screen (MARGIN in
 * viewer.ts) — put it at the top and it would hide the hit you just landed on.
 *
 * It is not permanent UI. `Mod+F` brings it up, `Esc` dismisses it. It does not
 * violate "no permanent UI" (§9) for the same reason the outline does not.
 *
 * What is searched is the source text, not the DOM. View mode renders progressively
 * (EAGER and IntersectionObserver in viewer.ts) and `content-visibility: auto` also
 * applies, so off-screen content can be "present but not laid out". An
 * implementation that walks `innerText` would miss most of the document; this is
 * also why the browser's built-in `Ctrl+F` is unusable here. Following the same
 * thinking as the outline taking its headings from tokens, we look at the side that
 * does not depend at all on render progress — the source text held by main.ts.
 *
 * The view-mode highlighting (second half of this file) lives here too. Putting it
 * in viewer.ts would make it baggage carried on every startup — even startups that
 * never use search — because view mode is read at launch. Since startup speed is the
 * first priority (§4), the cost of search is paid only by whoever presses `Mod+F`.
 *
 * This module is imported dynamically from main.ts. It is not loaded until `Mod+F`
 * is pressed (nor is its CSS). Same shape as outline.ts.
 */
import { scrollToLine } from "./viewer";
import "./find.css";

/** One hit. The line number is the view-mode jump target; the index is the edit-mode selection range. */
export interface FindMatch {
  /** Line number in the source (0-based). */
  line: number;
  /** Offset from the start of the text, in characters. */
  index: number;
}

export interface FindOptions {
  /** The authoritative text (`text` in main.ts). This is what gets searched. */
  text: string;
  /** The line search starts from. The first hit is looked for at or after this line. */
  from: number;
  /** Jump to and show the currently selected hit. `query` is needed as the spelling to highlight. */
  show(query: string, match: FindMatch): void;
  /** Clear the highlight. Called on close. */
  clear(): void;
  /** On close, return focus to where it was. */
  restore(): void;
}

let root: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let counter: HTMLElement | null = null;
let options: FindOptions | null = null;

/** The current list of hits, and which one within it is selected. */
let matches: FindMatch[] = [];
let current = 0;
/** The line to start searching "from here on" when the query is retyped. It follows along on every jump. */
let anchor = 0;

/** Start offset of each line. Used to derive a line number from a hit's offset (rebuilt on every open). */
let lineStarts: number[] = [];
/** The case-folded text. Remembered so we do not refold on every keystroke. */
let folded = "";

/**
 * Only case is folded. Full-width vs half-width, and hiragana vs katakana, are
 * treated as different characters. There are two reasons.
 *
 * 1. Offsets would shift. Normalisation such as `NFKC` changes the character count
 *    (the 2 characters `ﾊﾞ` become the 1 character `バ`). An offset found in the
 *    folded string would no longer correspond to an offset in the original text, and
 *    both the jump target and the highlight would be off by one each time. Keeping a
 *    mapping table back to the original would fix it, but that is far too heavy a
 *    mechanism to attach to a single search feature (second priority in §4)
 * 2. It would become harder to predict. "I typed katakana and it matched hiragana"
 *    is half the time a welcome hit and half the time an obstacle when you are
 *    trying to narrow down. The cleverer it gets, the less explicable the resulting
 *    count becomes
 *
 * Case alone is folded. There is no reason to treat `Enter` and `enter` as different
 * things, and failing to recall the exact spelling of alphanumerics happens
 * routinely even in a Japanese document.
 */
const fold = (s: string): string => s.toLowerCase();

/**
 * Decide the "folded text" and "folded query" used for searching.
 *
 * `toLowerCase` occasionally changes the character count (`İ` becomes the 2
 * characters `i̇`). When the length changes, offsets found on the folded side no
 * longer correspond to the original text, so in that case only we give up
 * case-insensitivity and search the raw strings. A miss is more visible to the user
 * than silently jumping one position over.
 */
function prepare(query: string): { hay: string; needle: string } {
  const text = options?.text ?? "";
  const needle = fold(query);
  if (folded.length === text.length && needle.length === query.length) return { hay: folded, needle };
  return { hay: text, needle: query };
}

/**
 * Collect every hit in the text.
 *
 * Markup characters are not stripped; the raw Markdown is searched as-is. Searching
 * for `**強調**` also hits the `**`, and `$x^2$` matches by its literal spelling. We
 * still take this side because:
 *
 * - This exact string is what is visible in edit mode. It is a requirement that the
 *   same key means the same thing in both modes (§9-2), and if one side searched a
 *   different string the counts would disagree
 * - The correspondence to line numbers does not break. Building a separate
 *   markup-stripped text would require a mapping table from those offsets back to
 *   the original lines. If the table drifts, the jump target is wrong — and the
 *   drift goes unnoticed (same lesson as §5: do not add more things that fail
 *   silently)
 * - It is predictable. "If what you typed exists in the file, it matches there" is
 *   the same rule as grep, and needs no explanation (second priority in §4)
 *
 * All we lose is matching across markup boundaries (「強調され」 in `**強調**され`,
 * i.e. a word that spans the closing markers). Matching the on-screen spelling does
 * look more correct in some situations, but that correctness rides on the
 * correctness of a mapping table, and this way is harder to break.
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

/** Derive a line number (0-based) from an offset. Binary search over the line-start table. */
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
  // Closing leaves you where you last jumped to. If the place you searched your way
  // to disappeared, the search would have been pointless. All we do here is clear the
  // highlight and return focus.
  done?.clear();
  done?.restore();
}

/** When `Mod+F` is pressed again while already open. Like the browser, return to a state ready for retyping. */
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
  // Let the IME through. Searching Japanese is the main use, so this is essential.
  // The guard against running mid-composition is needed on this side too, not only
  // in onKey (see isComposing below).
  input.addEventListener("input", (e) => {
    // Do not search on unconfirmed composition text. Jumping around on the "k",
    // "け", "けん" of typing 「けんさく」 loses the place you were reading before
    // you ever confirmed the word.
    if ((e as InputEvent).isComposing) return;
    update();
  });
  // Run exactly once at the moment composition is confirmed. This picks up what was
  // rejected above.
  input.addEventListener("compositionend", () => update());

  counter = document.createElement("span");
  counter.className = "gera-find-count";

  root.append(input, counter);
  document.body.append(root);
  window.addEventListener("keydown", onWindowKey);
  input.focus();
}

/**
 * The query changed, so search again. Select the first hit at or after the place the
 * search started from. Selecting from the top would throw you back to the beginning
 * every time you invoked search partway through a long document (the same reason the
 * outline aligns its initial selection with your current position).
 */
function update(): void {
  if (!input) return;
  matches = search(input.value);
  const at = matches.findIndex((m) => m.line >= anchor);
  current = at < 0 ? 0 : at;
  render();
}

/** Show the currently selected hit and display the count. */
function render(): void {
  if (!options || !input || !counter) return;
  // Make the place we jumped to the next starting point. This is so that adding one
  // more character searches again from where you are now; pinning the start to where
  // search was opened would drag you back to the top each time you narrowed down.
  anchor = matches[current]?.line ?? anchor;

  if (!input.value || !matches.length) {
    // Say nothing when the query is empty. Showing "not found" before anything has
    // been typed announces a failure when the user has not done anything.
    counter.textContent = input.value ? "見つかりません" : "";
    counter.classList.toggle("gera-find-none", Boolean(input.value));
    options.clear();
    return;
  }
  // Show which hit this is and how many there are in total. Without it you cannot
  // tell whether there are more or this is the last, and all you can do is keep
  // pressing Enter.
  counter.textContent = `${current + 1} / ${matches.length}`;
  counter.classList.remove("gera-find-none");
  options.show(input.value, matches[current] as FindMatch);
}

/** To the next hit (`step` of 1) or the previous (-1). Wrap at the ends — same manners as the outline's `move`. */
function move(step: number): void {
  if (!matches.length) return;
  current = (current + step + matches.length) % matches.length;
  render();
}

/**
 * Allow `Esc` to close even after focus has moved into the document.
 *
 * The input field has no backdrop (so as not to hide the text), so focus leaves the
 * moment the user touches the document. At that point the `onKey` below no longer
 * fires, and there would be no way to close. While focus is in the input field
 * `onKey` stops the event first (stopPropagation), so this never runs twice.
 */
function onWindowKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && !e.isComposing) close();
}

function onKey(e: KeyboardEvent): void {
  // Enter during composition belongs to the IME. We must not jump to the next hit
  // while a candidate is being confirmed (same as the outline's onKey).
  if (e.isComposing) return;
  switch (e.key) {
    case "Escape":
      close();
      break;
    case "Enter":
      move(e.shiftKey ? -1 : 1);
      break;
    default:
      // Typed characters go straight to the input field. By not swallowing them,
      // keys with Mod reach the window-level handler (main.ts) untouched.
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// ---------------------------------------------------------- Highlighting hits

/**
 * In view mode, colour the hit and jump to it.
 *
 * The document DOM is not rewritten (CSS Custom Highlight API). Wrapping in `<mark>`
 * would break both the `data-line` correspondence (§6) and the block replacement
 * done by `renderFragment` (local editing), because the shape changes by exactly the
 * wrapper. Highlighting is kept entirely within the presentation layer. Where the
 * API is unavailable we give up only the highlight — jumping still works, so the
 * tool does not die.
 *
 * Only blocks currently on screen get coloured. This is not an economy measure; it
 * is because doing otherwise breaks (see `watch` below).
 */
const ALL = "gera-find";
const CURRENT = "gera-find-current";

const highlights: HighlightRegistry | undefined =
  typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : undefined;

/** Offset from the top edge, the same as a heading's landing point (same value as MARGIN in viewer.ts). */
const MARGIN = 24;

/** Blocks containing hits, and the indices of the hits belonging to each (positions within `matches`). */
let groups = new Map<HTMLElement, number[]>();
/** Of those, the ones currently on screen. These are the only ones we may colour. */
let onScreen = new Set<HTMLElement>();
let watching: IntersectionObserver | null = null;
/** Only right after a jump, check whether the hit is on screen and nudge it into view. */
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

/** From `lines` (each block's start line), find the index of the block containing that line. -1 if none. */
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
 * Collect the ranges of hits within a single block.
 *
 * Text nodes are read directly. `nodeValue` is readable even in a block that
 * `content-visibility: auto` has not laid out yet, so this does not depend on render
 * progress (`innerText` does).
 *
 * Hits that span node boundaries are not picked up — in `**強調**` the node is split
 * by `<strong>`, so 「強調」 matches but 「強調され」 does not. This is consistent
 * with the nature of the search itself (the `search` above looks at the raw text
 * with markup characters intact, so 「強調され」 is not counted as a hit in the
 * first place).
 */
function rangesIn(block: HTMLElement, query: string): Range[] {
  const lower = fold(query);
  // For spellings whose length changes when folded, offsets do not correspond. In
  // that case search raw (the same judgement as prepare).
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
 * Rebuild the highlights for the blocks currently on screen.
 *
 * Ranges from off-screen blocks must not be mixed in. Measured (WebKitGTK 2.52,
 * 2026-09-03): a Range created inside a block whose contents were skipped by
 * `content-visibility: auto` is painted as a band covering that entire block — and
 * painted on top of an unrelated block that is on screen. The range itself is
 * correct (`toString()` returns 「検索」); the cause is that the side computing
 * positions cannot measure contents that have not been laid out. It is not merely a
 * cosmetic problem — whole paragraphs that did not match get coloured, so you can no
 * longer read where the hits actually are.
 *
 * Blocks that are on screen are always laid out, so painting only those avoids it.
 * Entry and exit are tracked with an IntersectionObserver (same manners as fillMath
 * in viewer.ts).
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
    // Where they overlap, paint with the colour of the one selected hit.
    one.priority = 1;
    highlights.set(CURRENT, one);
  } else {
    // If the selected hit is off screen, clear its colour too (same reason as above).
    highlights.delete(CURRENT);
  }
  if (wantNudge && target && scrollerNow) {
    wantNudge = false;
    nudge(scrollerNow, target);
  }
}

/**
 * Find the blocks containing hits and observe their entry and exit. Only rebuilt when the query changes.
 */
function watch(scroller: HTMLElement, doc: HTMLElement, query: string): void {
  watching?.disconnect();
  groups = new Map();
  onScreen = new Set();
  scrollerNow = scroller;
  queryNow = query;

  const blocks: HTMLElement[] = [];
  const lines: number[] = [];
  // Only the direct children of `.gera-doc` are counted. Both the unit that
  // content-visibility acts on and the line correspondence live here (viewer.ts).
  for (const child of doc.children) {
    const el = child as HTMLElement;
    // A wrapper may not carry a line itself. Tables are wrapped in `.gera-table`, and
    // it is the inner `<table>` that has the line. Dropping the wrapper outright
    // would mean not a single hit inside a table gets highlighted.
    const own = el.dataset.line ?? el.querySelector<HTMLElement>("[data-line]")?.dataset.line;
    const line = Number(own);
    if (own !== undefined && Number.isFinite(line)) {
      blocks.push(el);
      lines.push(line);
    }
  }

  // Group the hits by block. Because we look them up by line, nothing is missed even off screen.
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
    // No margin. Blocks that are on screen are exactly the range we can assert is
    // laid out; reaching ahead breaks that (see the note on repaint).
    { root: scroller },
  );
  for (const block of groups.keys()) watching.observe(block);
}

/**
 * If the hit itself is not on screen, nudge it into view.
 *
 * Scrolling to the top of the block is not enough. In long lists or code blocks, the
 * head of the block can be at the top edge while the hit is still below the screen.
 */
function nudge(scroller: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect();
  if (!rect.height) return;
  const top = scroller.getBoundingClientRect().top;
  if (rect.top >= top && rect.bottom <= top + scroller.clientHeight) return;
  scroller.scrollTop += rect.top - top - MARGIN;
}

/** Jump to the hit in view mode and colour it. It lands even if the target block is not yet rendered. */
export function showInView(scroller: HTMLElement, query: string): void {
  const at = matches[current];
  if (!at) {
    clearInView();
    return;
  }
  const doc = scroller.querySelector<HTMLElement>(".gera-doc");
  // Rebuild only when the query changed. Just advancing to the next hit can reuse the observer as-is.
  if (doc && (query !== queryNow || scroller !== scrollerNow)) watch(scroller, doc, query);
  // Leave the jumping to viewer.ts. That is the only path that lands even on an
  // unrendered block (settle, which re-aligns while replacing content-visibility's
  // estimates with real measurements).
  scrollToLine(scroller, at.line);
  wantNudge = true;
  // Repaint only after the re-alignment is done. The observer learns that the target
  // block entered the screen just before the next frame is painted, so we queue
  // behind that (same shape as settle in viewer.ts). repaint is also called from the
  // observer side, so whichever runs first, the end state is the same.
  requestAnimationFrame(() => {
    requestAnimationFrame(repaint);
  });
}
