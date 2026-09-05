/**
 * Jump to a heading (see DESIGN.md §9-2 "Finding", and step 5 of the implementation
 * order in §14).
 *
 * This is the first tool that addresses the author's own pain directly (§2) — "just
 * locating where the thing I want to know is written is hard work". That is a
 * different requirement from the text block (the friend's pain), and all it answers
 * here is letting you pick a jump target.
 *
 * Not a sidebar: it overlays the text only when summoned. There are three reasons.
 *
 * 1. What you want is a jump target, not a map. The pain is "finding where something
 *    is written", not wanting a table of contents in view at all times. Once it has
 *    served its purpose it can disappear
 * 2. It does not steal width from the text. The text block for reading long Japanese
 *    end to end is the main thing (§9-1), and line length is the quality of that
 *    block itself. UI parked at the side erodes that quality the whole time you read
 * 3. No "show it or not" setting is needed. A sidebar has an open/closed state, state
 *    becomes a setting, and a setting becomes a concept you must remember (second
 *    priority in §4). With an overlay, the only thing to remember is the one key that
 *    summons it
 *
 * This does not violate "no permanent UI" (§9). It is not permanent: it appears only
 * when summoned and vanishes once you jump. Nothing ever sits on the screen.
 *
 * This module is imported dynamically from main.ts. On the path of merely launching
 * and reading — which is the normal way it is used (§1) — it is never loaded once.
 * The CSS is imported here for the same reason (same shape as editor.ts).
 */
import "./outline.css";

/** One heading in the list. viewer.ts builds these from markdown-it tokens. */
export interface OutlineHeading {
  /** Number of `#` (1 to 6). */
  level: number;
  /** The heading text with markup characters stripped. This is what filtering matches against. */
  text: string;
  /** Line number in the source (0-based). Used to specify the jump target. */
  line: number;
}

export interface OutlineOptions {
  headings: OutlineHeading[];
  /** The line currently visible at the top of the screen. The selection on open is aligned to this. */
  current: number;
  /** Jump to the line of the chosen heading. Called after closing. */
  jump: (line: number) => void;
  /** On close, return focus to where it was. */
  restore: () => void;
}

let root: HTMLElement | null = null;
let options: OutlineOptions | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLElement | null = null;

/** The headings currently listed (after filtering), and which one within them is selected. */
let shown: OutlineHeading[] = [];
let selected = 0;
/** The shallowest heading level in that document. Indentation is counted as the difference from here. */
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
  // Return focus on close. Without it, focus stays on a removed element, the arrow
  // keys reach nowhere, and to the user it looks as though input has stopped being
  // accepted.
  restore?.();
}

export function open(opts: OutlineOptions): void {
  close();
  options = opts;
  baseLevel = opts.headings.reduce((min, h) => Math.min(min, h.level), 6);

  root = document.createElement("div");
  root.className = "gera-outline";
  // Clicking empty space on the backdrop closes it. You must be able to get out
  // without knowing about Esc.
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
  // Let the IME through. Filtering Japanese headings is the main use, so this is essential.
  input.addEventListener("input", () => {
    selected = 0;
    render();
  });

  list = document.createElement("div");
  list.className = "gera-outline-list";
  list.addEventListener("mousedown", (e) => {
    // Caught on mousedown, not click. Waiting for click would let the backdrop's
    // mousedown run first and close it before us.
    const item = e.target instanceof Element ? e.target.closest(".gera-outline-item") : null;
    if (!(item instanceof HTMLElement)) return;
    e.preventDefault(); // do not let focus be taken from the input field
    selected = Number(item.dataset.index);
    choose();
  });

  box.append(input, list);
  root.append(box);
  document.body.append(root);

  // The selection on open is the place you are currently reading. Putting it at the
  // top would leave you unable to tell where you are when you invoke it partway
  // through a long document, and you would have to travel back there every time.
  selected = Math.max(
    0,
    opts.headings.reduce((at, h, i) => (h.line <= opts.current ? i : at), 0),
  );
  render();
  input.focus();
}

/**
 * Filtering is a case-insensitive substring match.
 *
 * No fuzzy matching (the kind that picks up scattered characters). Japanese has no
 * word boundaries and headings are dense with kanji, so allowing scattered matches
 * means almost every heading matches almost every input. The purpose of filtering is
 * to reduce the candidates, and dropping what does not match works more directly
 * than papering over it with ranking. A substring match also has the advantage that
 * the matched span can be shown in bold exactly where it is (`.gera-outline-mark`) —
 * seeing why a row survived is itself guidance.
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
    // Level is shown by indentation (outline.css). Depth is capped at 6 steps.
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
  // Wrap rather than stop at the ends. In a long document, one press of ↑ is enough
  // to reach the last heading.
  selected = (selected + step + shown.length) % shown.length;
  render();
}

function choose(): void {
  const heading = shown[selected];
  if (!heading || !options) return;
  const jump = options.jump;
  // Close first. Aligning the jump target (settle in viewer.ts) takes measurements,
  // and with the backdrop still in place it could misjudge whether what it measures
  // is off screen.
  close();
  jump(heading.line);
}

function onKey(e: KeyboardEvent): void {
  // ↑↓ and Enter during composition belong to the IME. The list must not move or
  // close while a candidate is being chosen.
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
      // Typed characters go straight to the input field. By not swallowing them,
      // keys with Mod reach the window-level handler (main.ts) untouched.
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}
