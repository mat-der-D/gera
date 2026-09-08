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
 * The rule the whole module follows is one sentence: **the band keeps its height in
 * the window and the lines move under it.** Whatever moves the view — the wheel,
 * `PageUp` / `PageDown`, the scrollbar, a jump from the heading list, find or a link —
 * the band stays where it is and takes the line that arrives there (§9-16). A scroll
 * gera performs to carry the band itself is the one exception, and `holdUntil` below is
 * how it is told apart.
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
 * During a scroll gera itself started to carry the band (`↑↓`, `Shift+↑↓` at the edge
 * of the window) the tracker keeps its line and travels with the text; during every
 * other scroll — the wheel, `PageUp` / `PageDown`, the scrollbar, a jump — it keeps its
 * height in the window instead and takes the line that arrives there. A scroll event
 * cannot tell the two apart, so this says which.
 *
 * It is a deadline rather than a flag because one movement is not one scroll: `settle`
 * in viewer.ts re-scrolls two frames later, once the deferred equations have been
 * typeset (§5-4). A flag cleared on the next line would be gone by then.
 */
let holdUntil = 0;
let settleTimer = 0;

/**
 * The height in the window the band is holding.
 *
 * It has to be remembered rather than recomputed: by the time a scroll is reported the
 * band has already been carried away from the height it was holding, so asking where it
 * is answers with where the scroll put it.
 * Measured: after a PageDown the held height came out as -413px — off the top of the
 * window — and nothing could be found there to land on.
 */
let heldY = 0;

/** Fraction of a scroll the engine would not apply, spent on the next press. */
let carry = 0;

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
  // A point can land between two blocks — the margin above a paragraph, the air around
  // a heading. What answers there is the nearest text, whose rectangle does not contain
  // the point at all, and taking it would leave the band sitting on blank space
  // (measured: PageDown put it in the gap under a heading). So a rectangle counts only
  // if it contains the point that produced it, and otherwise the probe walks down until
  // one does. Walking down and not up is what "the line that arrived at this height"
  // means: a gap arriving is the next line arriving.
  for (let d = 0; d <= 96; d += 4) {
    const rect = probe(y + d);
    if (rect && rect.top <= y + d && rect.top + rect.height >= y + d) return rect;
  }
  return probe(y);
}

function probe(y: number): { top: number; height: number } | null {
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

/**
 * One line of the text column. The band is never drawn shorter than this.
 *
 * Some blocks are far shorter than a line. `---` is an `<hr>` whose border box is the
 * 1px rule itself (viewer.css), so the measured rectangle is 1px tall and the band
 * disappears into it — the owner could not tell where the tracker was. Growing a short
 * rectangle to a line, around its own centre, keeps the band the same object everywhere
 * instead of one that vanishes on certain blocks.
 */
function bodyLine(): number {
  const doc = host?.querySelector<HTMLElement>(".gera-doc");
  const value = doc ? parseFloat(getComputedStyle(doc).lineHeight) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 24;
}

function record(top: number, height: number): void {
  const min = bodyLine();
  if (height < min) {
    top -= (min - height) / 2;
    height = min;
  }
  const rect = host?.getBoundingClientRect();
  docTop = top - (rect ? rect.top : 0) + (host?.scrollTop ?? 0);
  lineHeight = height;
}

/**
 * Whether the tracked line is inside the window.
 *
 * Since §9-16 every scroll takes the band with it, so this is false only in the moments
 * between a scroll and the measurement that follows it, or where `sync` could find no
 * line to land on at all.
 */
function visible(): boolean {
  const rect = host?.getBoundingClientRect();
  if (!rect) return false;
  const top = windowTop();
  return top + lineHeight > rect.top && top < rect.bottom;
}

/**
 * Draw, and make where it landed the height to hold from now on.
 *
 * Called wherever the band is deliberately placed — its own keys, picking it up,
 * pulling the window back, a scroll gera performed itself. Not from `sync`, which is
 * the other direction: `sync` asks which line is at the held height, so letting it move
 * that height would let the anchor follow the line it just found. Measured: four line
 * scrolls walked the band 125px down the window, because each landing redefined the
 * height the next probe used.
 */
function anchor(): void {
  paint();
  if (visible()) heldY = windowTop();
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
      return;
    }
  }
}

/**
 * Move the tracker a line and leave the window where it was: the paper is scrolled by
 * exactly the distance the tracker travelled, putting the band back on the pixel it
 * started from.
 *
 * This is what an unmodified `↑↓` does while the tracker is on. It is not the same as
 * scrolling the paper by a line and taking whatever arrives at that height, which is
 * what it used to do — the owner asked for this shape instead (2026-09-07), and it is
 * the better one for two reasons. The line advances by exactly one every press, rather
 * than by whatever the fixed scroll happens to land on. And the paper moves by the real
 * distance between the two lines, so a paragraph margin or a heading is crossed
 * correctly instead of by a body line's height.
 *
 * At the end of the document the paper cannot scroll any further, and the band moves
 * down the window instead. That is the honest outcome: there is no more paper to move.
 */
function stepWithPaper(dir: 1 | -1): void {
  if (!host) return;
  const before = windowTop();
  step(dir);
  const delta = windowTop() - before;
  if (delta !== 0) {
    hold(200);
    // The engine keeps `scrollTop` on whole pixels while the distance between two lines
    // is fractional, so each press leaves a fraction unscrolled. Unspent, it piles up:
    // measured, the band walked 3px down the window over twelve presses. Carry the
    // remainder into the next press instead. The clamp is so that hitting the end of
    // the document — where the scroll is refused wholesale, not rounded — does not load
    // the carry with a whole screen.
    const wanted = host.scrollTop + delta + carry;
    host.scrollTop = wanted;
    carry = Math.max(-1.5, Math.min(1.5, wanted - host.scrollTop));
  }
  anchor();
}

/**
 * Put the tracker on the first line of the window — the line about to be read (§9-9).
 *
 * Only `toggle` calls this now. It used to have a key of its own (`Enter`, for taking a
 * band left off screen by a jump), which was removed on 2026-09-08: pressing `Mod+L`
 * twice goes off and on again, and turning on runs exactly this, so the two ended at
 * the same state (§9-12).
 */
function pickUp(): void {
  const rect = host?.getBoundingClientRect();
  if (!rect) return;
  const line = lineAt(rect.top + 1);
  if (!line) return;
  carry = 0;
  record(line.top, line.height);
  anchor();
}

/**
 * Bring the window back to the tracker, without moving the tracker (§9-9).
 *
 * Since §9-16 the band travels with every scroll, so it is off screen only where a
 * measurement has not landed yet or found no line at all. This is the way back from
 * that: rare now, and still the only one.
 */
function pullBack(): void {
  const rect = host?.getBoundingClientRect();
  if (!rect || !host) return;
  hold(200);
  carry = 0;
  host.scrollTop += windowTop() - (rect.top + rect.height / 3);
  anchor();
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
  const line = lineAt(heldY + lineHeight / 2);
  if (!line) return;
  record(line.top, line.height);
  paint();
}

function onScroll(): void {
  if (!on) return;
  if (performance.now() < holdUntil) {
    // gera scrolled to carry the band, so it travelled with the text and kept its line;
    // the height it arrived at is the one to hold from now on.
    anchor();
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
export function toggle(scroller: HTMLElement): boolean {
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
  carry = 0;
  clearTimeout(settleTimer);
  host?.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onResize);
  band?.remove();
  band = null;
  host = null;
}

/**
 * A jump moved the window on its own (`Mod+Shift+O`, `Mod+F`, a link).
 *
 * The tracker goes along, under exactly the rule `PageUp` / `PageDown` follows: the
 * band keeps its height in the window and takes the line that arrives there (the
 * owner's call, 2026-09-09 — §9-16). It used to stay behind instead, keeping the place
 * being read while the view went elsewhere; that is the position §9-11 argued for, and
 * what it bought — jumping to look something up and coming back with `Shift+↑↓` — is
 * what this gives up.
 *
 * All that is needed is to get out of the way. The scroll the jump just performed is
 * reported asynchronously, so clearing the hold here is enough for it to be read as a
 * scroll the reader asked for; `settle`'s second pass two frames later (§5-4) arrives
 * as another scroll and simply re-runs the measurement.
 */
export function afterJump(): void {
  if (!on) return;
  holdUntil = 0;
  // The band would otherwise sit on the old pixel until `sync` runs, which reads as it
  // having stayed behind.
  paint();
}

/**
 * Keys that belong to the tracker while it is on. Returns whether the key was taken.
 *
 * Only `Shift+↑↓` (and `Shift+J` / `Shift+K`) move the band. Scrolling — a line, a page,
 * the wheel, the scrollbar — is not taken here at all: the scroll handler above keeps
 * the band at its height in the window, which is how the line it points at advances as
 * the paper moves.
 *
 * `Enter` used to be taken here as well, to bring a band left off screen by a jump back
 * to the line being read. It was removed on 2026-09-08 (§9-12): `Mod+L` twice reaches
 * the identical state, so the binding bought nothing and held an unmodified key in view
 * mode for a case that only arises after a jump.
 *
 * That split is the owner's reading of it (2026-09-07): moving to the next line is one
 * act with two ways to perform it — move the eye, or move the paper. The tracker's
 * coordinate is a place in the window, independent of the paper, so both work and
 * neither is the other. What is separated is whether the paper moves.
 */
export function handleKey(e: KeyboardEvent): boolean {
  if (!on || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;

  const key = e.key.toLowerCase();
  const down = key === "arrowdown" || key === "j";
  const up = key === "arrowup" || key === "k";
  if (down || up) {
    if (e.shiftKey) {
      // Move the band and leave the paper alone. Off screen — which since §9-16 means
      // a measurement did not land — the first press only brings the window back and
      // does not move the tracker. gera already asks for a second press once, when
      // `Mod+R` would throw away unsaved work (§9-6 (d)), so this manner has been
      // learned already, and the reversible side is the default (§11).
      if (!visible()) pullBack();
      else {
        step(down ? 1 : -1);
        keepInView();
        anchor();
      }
      e.preventDefault();
      return true;
    }
    // Unmodified: move the band and bring the paper along so the band stays put. While
    // the band is off screen there is nothing to carry, so this is left to the plain
    // scroll in main.ts — the paper moves and the tracker keeps the line it is on.
    if (!visible()) return false;
    stepWithPaper(down ? 1 : -1);
    e.preventDefault();
    return true;
  }
  return false;
}
