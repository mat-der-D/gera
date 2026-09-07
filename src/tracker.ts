/**
 * The reading tracker (§9-11).
 *
 * A band drawn behind the line being read. `Mod+L` turns it on and off, and while it
 * is on the arrow keys (and `j` / `k`) move the band instead of scrolling the view.
 * Off by default, and not remembered across launches — the owner's call, so that
 * "why is it on?" never depends on what happened in a previous session (§9-11).
 *
 * View mode only. Unmodified keys belong to the text in edit mode.
 *
 * The rule the whole module follows is one sentence: **while the tracker is on
 * screen it keeps its height in the window and the lines move under it; while it is
 * off screen the view moves alone and the tracker stays where it was.** Drift is
 * therefore only ever created by a jump (`Mod+Shift+O`, `Mod+F`, a link), which is
 * axis 3 = 1 in §9-9 — the reversible side.
 *
 * Two facts about the document shape drive the implementation (§9-9).
 *
 * 1. **There is no element that corresponds to a line.** A paragraph is one element
 *    however many lines it wraps to, so the position of a line can only be measured,
 *    never looked up. `caretRangeFromPoint` is what does the measuring here
 *    2. **`content-visibility: auto` (§5-4) means off-screen blocks are not laid
 *    out.** Nothing outside the viewport can be measured at all, so every movement
 *    is expressed as "a point in the window", and the view is scrolled first
 *    whenever the next line would fall outside it
 *
 * The position is held as `docTop` — a distance from the top of the scrolled content,
 * not a line number. There is no line number to hold: see 1 above.
 */
import "./tracker.css";

export interface TrackerOptions {
  /** The banner (main.ts). Used once, when a jump leaves the tracker off screen. */
  notify: (message: string) => void;
}

let opts: TrackerOptions | null = null;
let host: HTMLElement | null = null;
let band: HTMLElement | null = null;
let on = false;

/** Distance from the top of the scrolled content to the top of the tracked line. */
let docTop = 0;
/** Height of the tracked line. Also the step size for moving and for edge scrolling. */
let lineHeight = 0;

/**
 * Until when scrolls keep the tracker on its line instead of moving it.
 *
 * During a scroll gera itself started the tracker keeps its line and travels with the
 * text; during a scroll the user asked for (wheel, `PageUp` / `PageDown`, the
 * scrollbar) it keeps its height in the window instead and takes the line that arrives
 * there. A scroll event cannot tell the two apart, so this says which.
 *
 * It is a deadline rather than a flag because a jump does not finish in one scroll:
 * `settle` in viewer.ts re-scrolls two frames later, once the deferred equations have
 * been typeset (§5-4). A flag cleared on the next line would be gone by then.
 */
let holdUntil = 0;
let settleTimer = 0;

function hold(ms: number): void {
  holdUntil = Math.max(holdUntil, performance.now() + ms);
}

export function isOn(): boolean {
  return on;
}

/** The text column. Everything is measured down its centre, never at its edges. */
function column(): DOMRect | null {
  const doc = host?.querySelector<HTMLElement>(".gera-doc");
  return doc ? doc.getBoundingClientRect() : null;
}

/**
 * The line under a point in the window, in window coordinates.
 *
 * The caret is asked first. Where there is no text under the point — a display
 * equation, an image, the gap between two blocks — it either answers with a position
 * in a neighbouring node or refuses, and the top-level block under the point is used
 * instead. For an equation that means the band covers the whole block, which is the
 * right answer: the block is the unit being read.
 */
function lineAt(y: number): { top: number; height: number } | null {
  const col = column();
  if (!col) return null;
  const x = col.left + col.width / 2;

  const caret = document.caretRangeFromPoint?.(x, y);
  if (caret) {
    // A collapsed range has no rectangles in WebKit, so widen it by one character.
    const range = caret.cloneRange();
    const node = range.endContainer;
    const len = node.nodeType === Node.TEXT_NODE ? (node as Text).length : node.childNodes.length;
    if (range.endOffset < len) range.setEnd(node, range.endOffset + 1);
    else if (range.startOffset > 0) range.setStart(node, range.startOffset - 1);
    const rect = range.getClientRects()[0];
    if (rect && rect.height > 0) return { top: rect.top, height: rect.height };
  }

  const el = document.elementFromPoint(x, y);
  const block = el?.closest<HTMLElement>(".gera-doc > *");
  if (!block) return null;
  const rect = block.getBoundingClientRect();
  return { top: rect.top, height: rect.height };
}

/** Where the tracked line sits in the window right now. */
function windowTop(): number {
  const rect = host?.getBoundingClientRect();
  return (rect ? rect.top : 0) + docTop - (host?.scrollTop ?? 0);
}

function record(top: number, height: number): void {
  const rect = host?.getBoundingClientRect();
  docTop = top - (rect ? rect.top : 0) + (host?.scrollTop ?? 0);
  lineHeight = height;
}

/** Whether the tracked line is inside the window. Drift means this is false. */
function visible(): boolean {
  const rect = host?.getBoundingClientRect();
  if (!rect) return false;
  const top = windowTop();
  return top + lineHeight > rect.top && top < rect.bottom;
}

function paint(): void {
  if (!band || !host) return;
  const col = column();
  if (!col || !visible()) {
    band.hidden = true;
    return;
  }
  band.hidden = false;
  band.style.top = `${windowTop()}px`;
  band.style.height = `${lineHeight}px`;
  band.style.left = `${col.left}px`;
  band.style.width = `${col.width}px`;
}

/** Scroll gera's own way: the tracker keeps its line and rides along with the text. */
function scrollBy(delta: number): void {
  if (!host || delta === 0) return;
  hold(200);
  host.scrollTop += delta;
}

/**
 * Bring the tracked line back inside the window, leaving one line of air at the edge.
 * A line pressed right against the edge reads as though it were cut off.
 */
function keepInView(): void {
  const rect = host?.getBoundingClientRect();
  if (!rect) return;
  const air = lineHeight;
  const top = windowTop();
  if (top < rect.top + air) scrollBy(top - (rect.top + air));
  else if (top + lineHeight > rect.bottom - air) scrollBy(top + lineHeight - (rect.bottom - air));
}

/**
 * Step to the next line in the given direction.
 *
 * The window is walked a few pixels at a time rather than jumped by one line height,
 * because the distance to the next line is not the line height: between two paragraphs
 * there is a margin, and headings are set at a different size. Stepping stops as soon
 * as a line other than the current one answers. `caretRangeFromPoint` is cheap, and the
 * walk is bounded by the height of one screen.
 */
function step(dir: 1 | -1): void {
  const rect = host?.getBoundingClientRect();
  if (!rect) return;
  const from = windowTop();
  const limit = Math.max(rect.height, 1);
  const STRIDE = 4;
  for (let d = STRIDE; d < limit; d += STRIDE) {
    const y = dir > 0 ? from + lineHeight + d : from - d;
    // Nothing outside the window can be measured (content-visibility, §5-4), so scroll
    // first and carry on from the position the line has after the scroll.
    if (y < rect.top || y > rect.bottom) {
      scrollBy(dir * lineHeight);
      const moved = windowTop();
      if (moved === from) return; // The document cannot scroll any further
      step(dir);
      return;
    }
    const line = lineAt(y);
    if (!line) continue;
    if (dir > 0 ? line.top > from : line.top < from) {
      record(line.top, line.height);
      keepInView();
      paint();
      return;
    }
  }
}

/** Put the tracker on the first line of the window — the line about to be read (§9-9). */
function pickUp(): void {
  const rect = host?.getBoundingClientRect();
  if (!rect) return;
  const line = lineAt(rect.top + 1);
  if (!line) return;
  record(line.top, line.height);
  paint();
}

/** Bring the window back to the tracker, without moving the tracker (§9-9). */
function pullBack(): void {
  const rect = host?.getBoundingClientRect();
  if (!rect || !host) return;
  hold(200);
  host.scrollTop += windowTop() - (rect.top + rect.height / 3);
  paint();
}

/**
 * After a scroll the user asked for, take the line that is now at the height the band
 * was holding. This is what "PageDown moves the tracker into the destination" means
 * (§9-11): the band does not move in the window, the lines move under it.
 *
 * It runs once the scrolling has settled, not per frame. Measuring a line means
 * settling layout, and doing that every frame of a scroll makes frames miss vsync
 * (§5-2). The intermediate positions of a scroll are not read by anyone.
 */
function sync(): void {
  const held = windowTop();
  const line = lineAt(held + lineHeight / 2);
  if (!line) return;
  record(line.top, line.height);
  paint();
}

function onScroll(): void {
  if (!on) return;
  // Either gera scrolled, or the tracker is off screen and stays where it is. Both keep
  // the line; only the band's place in the window changes.
  if (performance.now() < holdUntil || !visible()) {
    paint();
    return;
  }
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(sync, 120);
}

function onResize(): void {
  if (on) paint();
}

// --------------------------------------------------------------------- entry points

/** `Mod+L`. Returns the state it moved to, for the banner. */
export function toggle(scroller: HTMLElement, options: TrackerOptions): boolean {
  opts = options;
  if (on) {
    off();
    return false;
  }
  host = scroller;
  on = true;
  band = document.createElement("div");
  band.className = "gera-tracker";
  document.body.append(band);
  host.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  pickUp();
  return true;
}

/**
 * Turn it off. Also called when leaving view mode and when the document is replaced:
 * the position is measured against a layout that no longer exists, so keeping it would
 * put the band on a line nobody chose.
 */
export function off(): void {
  if (!on) return;
  on = false;
  clearTimeout(settleTimer);
  host?.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onResize);
  band?.remove();
  band = null;
  host = null;
}

/**
 * A jump moved the window on its own (`Mod+Shift+O`, `Mod+F`, a link). The tracker does
 * not follow — that is axis 3 = 1, the side that can be undone (§9-9).
 *
 * Say so once, because the cost of two positions is that one of them is off screen and
 * invisible. The message names both ways back, so neither has to be memorised. It does
 * not carry the distance in lines: counting lines across blocks that are not laid out
 * would mean laying out the whole document, which is the cost content-visibility exists
 * to avoid (§5-4). This is narrower than the mock, which showed "12 lines above".
 */
export function afterJump(): void {
  if (!on) return;
  // Scroll events are delivered asynchronously, so this lands before the scroll the
  // jump just performed is reported. 500 ms covers `settle`'s second pass as well.
  hold(500);
  paint();
  if (!visible()) opts?.notify("トラッカーは画面の外にあります（↑↓ で戻る、Enter でここから読む）");
}

/**
 * Keys that belong to the tracker while it is on. Returns whether the key was taken.
 *
 * `PageUp` / `PageDown` are deliberately not taken: the webview scrolls, and the scroll
 * handler above moves the tracker into the destination. The same path serves the wheel
 * and the scrollbar, so all three behave alike without a case for each.
 */
export function handleKey(e: KeyboardEvent): boolean {
  if (!on || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;

  const down = e.key === "ArrowDown" || e.key === "j";
  const up = e.key === "ArrowUp" || e.key === "k";
  if (down || up) {
    // Off screen, the first press only brings the window back — it does not move the
    // tracker. gera already asks for a second press once, when `Mod+R` would throw away
    // unsaved work (§9-6 (d)), so this manner has been learned already. The reversible
    // side is the default (§11).
    if (!visible()) pullBack();
    else step(down ? 1 : -1);
    e.preventDefault();
    return true;
  }

  // `Enter` means "settle on this" inside the tools already (keys.ts), so reading it as
  // "start reading from here" adds no new idea.
  if (e.key === "Enter" && !visible()) {
    pickUp();
    e.preventDefault();
    return true;
  }
  return false;
}
