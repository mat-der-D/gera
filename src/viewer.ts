/**
 * Viewer mode (see DESIGN.md §4 and the implementation order 2 in §9).
 *
 * This is the heart of the app. The primary use is reading Markdown produced by AI
 * (§2); editing is an extension of that. So what this file is responsible for is
 * producing a "type area that lets you read more than 3000 characters of Japanese
 * straight through".
 *
 * This module is dynamically imported from main.ts. The point is to keep markdown-it,
 * DOMPurify and KaTeX out of the startup bundle: as long as startup speed is the first
 * priority (§3), we must not make startup load dependencies that only editor mode needs.
 * The CSS is imported here for the same reason — it is not loaded until viewer mode is
 * entered.
 *
 * Do not make the lazy loading of math any finer-grained than this (§5-6). Loading the
 * whole of KaTeX costs about 100 ms, and deferring it together with the whole viewer
 * mode already avoids most of that. "Skip KaTeX only for documents with no math" adds
 * too much branching and state for the 0.1 s it buys (the second priority in §4).
 */
import MarkdownIt from "markdown-it";
import type { Env, MarkdownIt as MarkdownItInstance, Token } from "markdown-it";
import DOMPurify from "dompurify";
import katexModule from "@vscode/markdown-it-katex";
import cjkFriendly from "markdown-it-cjk-friendly";
// Pull KaTeX's CSS and fonts in from node_modules and ship them inside the artifact.
// The CSP does not allow anything external (§7-2), so a CDN is not an option. This is
// placed before viewer.css so that, between rules of equal specificity, our own type
// area wins by coming later.
//
// This line is the reason katex is a direct dependency in package.json, pinned to the
// version the plugin above requires. If the versions drift apart, two copies of KaTeX
// end up in the build: the rendering comes from the plugin's version while the CSS
// applied comes from ours. Class names change across versions, so the mismatch goes
// unnoticed.
import "katex/dist/katex.min.css";
import "./viewer.css";

// This package is published as CJS and carries both `exports.__esModule` and
// `exports.default`. Read from the ESM side, some runtimes make default "the exports
// object itself" rather than "a function", and passing that straight to md.use fails
// with `apply is not a function`. The type says it is a function, so inspect the actual
// value and accept both shapes.
const katexPlugin =
  (katexModule as unknown as { default?: typeof katexModule }).default ?? katexModule;

/**
 * Embed the source line range into block elements.
 *
 * This is the only link between viewer mode and the raw source, and it supports three
 * uses at once. First, keeping the same place in view when switching modes (§5).
 * Second, the block-level local editing to be added later — the start line alone is not
 * enough, we also need to know where the block ends, so the end line is emitted too.
 * Third, letting reading aids (an outline and so on) pull headings and positions out of
 * the DOM.
 *
 * A markdown-it block token holds [start, end) in `map`, zero-based. The end is passed
 * through exclusive, unaltered — process it and the consumer can no longer confirm the
 * original meaning.
 */
const lineNumbers = (md: MarkdownItInstance): void => {
  md.core.ruler.push("gera_line_numbers", (state) => {
    for (const token of state.tokens) {
      // Closing tags (nesting -1) emit no attributes, so do not set them.
      if (!token.map || token.nesting < 0) continue;
      token.attrSet("data-line", String(token.map[0]));
      token.attrSet("data-line-end", String(token.map[1]));
    }
    return true;
  });
};

/**
 * Assign ids to headings. They are the landing points for in-document jumps (§9-1).
 *
 * The rule matches GitHub and VS Code — lowercase, drop ASCII punctuation, turn
 * whitespace into `-`. The reason to match is that tables of contents written by AI
 * link using GitHub's spelling. Invent our own spelling and the table of contents of a
 * document handed to us dies outright. Japanese is left as is (GitHub does the same).
 */
const slug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[!-/:-@[-`{-~]/g, "")
    .replace(/\s+/g, "-");

/**
 * Information about a single heading. This is what the outline (§9-2) lists.
 *
 * Taken from the tokens, not from the DOM. Viewer mode renders progressively (the
 * `content-visibility: auto` in viewer.css and `EAGER` below), so an off-screen heading
 * may be present in the DOM at a stage where its content has not been laid out. Capture
 * it at conversion time and it does not depend on rendering progress at all.
 */
export interface Heading {
  /** Number of `#` characters (1-6). */
  level: number;
  /** The heading text with markup characters stripped. */
  text: string;
  /** Line number in the source (zero-based). Passed to `scrollToLine`. */
  line: number;
  /** The id assigned to the heading (the same spelling as slug above). */
  id: string;
}

interface HeadingEnv extends Env {
  headings?: Heading[];
}

/**
 * The display string for a heading.
 *
 * `inline.content` is raw Markdown, so the markers of `**emphasis**` show up verbatim.
 * A list is not a place to "read" headings but a place to "tell them apart", so the
 * markers are dropped and only the letters kept. Math is emitted as its source spelling
 * rather than typeset — calling KaTeX inside the list would pay back here the cost we
 * deferred.
 */
const plainText = (inline: Token): string => {
  const parts: string[] = [];
  for (const child of inline.children ?? []) {
    if (child.type === "text" || child.type === "code_inline" || child.type.startsWith("math_")) {
      parts.push(child.content);
    }
  }
  const text = parts.join("").trim();
  return text || inline.content.trim();
};

const headingIds = (md: MarkdownItInstance): void => {
  md.core.ruler.push("gera_heading_ids", (state) => {
    // If the same heading occurs twice, append a counter as GitHub does. Duplicate ids
    // make every jump land on the first one, so later chapters become unreachable.
    const used = new Map<string, number>();
    const tokens = state.tokens;
    const found: Heading[] = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      const open = tokens[i];
      const inline = tokens[i + 1];
      if (!open || open.type !== "heading_open") continue;
      if (!inline || inline.type !== "inline") continue;
      const base = slug(inline.content) || "section";
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      const id = n === 0 ? base : `${base}-${n}`;
      open.attrSet("id", id);
      // Build the list here. Do not add a separate pass — walking to find headings is
      // exactly what this loop already does, and there is no reason to scan twice.
      found.push({
        level: Number(open.tag.slice(1)) || 1,
        text: plainText(inline),
        line: open.map?.[0] ?? 0,
        id,
      });
    }
    (state.env as HeadingEnv).headings = found;
    return true;
  });
};

/**
 * GFM task lists.
 *
 * markdown-it itself has tables, strikethrough and autolinks, but not task lists.
 * Rather than adding a whole plugin just for this, it is enough to swap the head of a
 * list item starting with `[ ] ` for a checkbox. It is read-only, so it is fixed as
 * disabled.
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

// ------------------------------------------------------------------ Math

/**
 * A holding area that keeps KaTeX's output outside of sanitization.
 *
 * Sanitization is for "HTML that came from the document" (§7-4 (b)). KaTeX's output is
 * our own HTML, generated by us with `trust: false`, and it depends on inline styles and
 * `<svg>` (for `\sqrt` and large brackets) — the document-oriented allow list drops
 * both, so passing it through would break the math.
 * Rather than loosening the allow list, never pass our own generated output through it
 * in the first place. At conversion time only a placeholder is emitted, and the real
 * thing is put back once sanitization is done.
 */
interface MathEnv extends Env {
  math?: (() => string)[];
}

/**
 * Leave only a placeholder and defer the call into KaTeX.
 *
 * The whole call is wrapped in a closure and stored. The point is not to typeset
 * off-screen math on the first pass; the cost breakdown is written at `fillMath` below.
 * The closure only captures markdown-it's token array and options, and those are not
 * rewritten after conversion is done.
 */
function slot(env: MathEnv, make: () => string): number {
  const math = (env.math ??= []);
  return math.push(make) - 1;
}

/**
 * Replace the HTML emitted by the KaTeX plugin with a placeholder.
 *
 * At the same time, wrap display math in `.gera-math` and give it a line number. The
 * plugin's output is only `<p class="katex-block">` and carries no data-line, so without
 * the wrapper all 175 display equations drop out of the mode-switch alignment entirely.
 */
const mathSlots = (md: MarkdownItInstance): void => {
  const rules = md.renderer.rules;

  const capture = (name: string, wrap: (token: Token, index: number) => string): void => {
    const inner = rules[name];
    if (!inner) return;
    rules[name] = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (!token) return "";
      // KaTeX cannot interpret \label, and the whole equation disappears, replaced by an
      // English error message in the body text. That said, the owner's own math
      // documents contain no \label at all (§5-5), so this is not a required measure but
      // essentially free insurance.
      token.content = token.content.replace(/\\label\s*\{[^}]*\}/g, "");
      return wrap(token, slot(env ?? {}, () => inner(tokens, idx, options, env, self)));
    };
  };

  capture("math_inline", (_token, i) => `<span data-math="${i}"></span>`);
  capture("math_inline_block", (_token, i) => `<span data-math="${i}"></span>`);
  capture("math_inline_bare_block", (_token, i) => `<span data-math="${i}"></span>`);
  // Put the real container for display math in place from the start. Even with empty
  // content, as long as `.gera-math` sits directly under `.gera-doc`, both the line
  // number (mode-switch alignment) and `contain-intrinsic-size` (the height estimate)
  // work from the beginning. Put an empty span there and swap it for a div later, and
  // for that interval the document is short by 175 blocks' worth of height.
  capture("math_block", (token, i) => {
    const map = token.map ? ` data-line="${token.map[0]}" data-line-end="${token.map[1]}"` : "";
    return `<div class="gera-math"${map} data-math="${i}"></div>`;
  });
};

const md = new MarkdownIt({
  // §7: with `html: false`, the <details> and <br> that are common in AI output come out
  // as raw text and are useless for review. Keep the expressive power intact and secure
  // safety with the sanitization below.
  html: true,
  linkify: true, // GFM autolinks
  typographer: false, // In Japanese, quote substitution is nothing but a nuisance
})
  // Fix bold in Japanese. Under CommonMark's delimiter run rules, if the character just
  // inside a closing `**` is Japanese punctuation (`。` `、` `）` `」`), the `**` is not
  // recognized as a closer and shows up verbatim in the body text. It breaks the same
  // way on GitHub and in VS Code.
  //
  // Measured against the owner's own material, this is not an edge case but the ordinary
  // way of writing. Across the 72,610 files under `~/Documents/dev` there are 83,297
  // occurrences of the shape `**…[。、）」]**`, which is 30% of all 274,711 `**…**`
  // pairs. Since gera is a viewer for reading Japanese documents (§1, §3), this cannot be
  // left alone.
  //
  // This plugin is the implementation of the CJK fix proposal to CommonMark itself
  // (https://github.com/commonmark/commonmark-spec/issues/650), and it replaces only
  // `scanDelims` on `md.inline.State`. The rule is rewritten only on the `*` side
  // (markdown-it sets `canSplitWord` only for `*`); the intra-word rule for `_` is left
  // untouched. The author is the person who submitted that proposal.
  //
  // Verified by measurement that it does not break existing behavior. Converting 2,997
  // files chosen at random from the owner's Markdown under both settings and comparing,
  // `<strong>` increased by 1,942 pairs, and the number of files where it decreased was
  // 0, as was the number of files where the tag structure changed anywhere other than
  // bold. Conversion time on findings.md went 120 → 114 ms, within measurement noise.
  .use(cjkFriendly)
  .use(lineNumbers)
  .use(headingIds)
  .use(taskLists)
  .use(katexPlugin, {
    // The default "htmlAndMathml" emits both HTML and MathML, but the sanitization below
    // drops MathML. Left at the default, we would be generating DOM to throw away every
    // time. The dominant cost is layout (§5-4), so cutting nodes pays off directly.
    output: "html",
    // Leaving `trust` at its default of false and not changing it is a requirement
    // (§7-4 (c)). It is recorded here to keep \href{javascript:...} and \includegraphics
    // shut out.
    trust: false,
    // Do not let it throw. Having the whole document fail to appear over one bad
    // equation is worse. The plugin replaces a failed equation with .katex-error and
    // moves on.
    throwOnError: false,
  })
  .use(mathSlots);

/**
 * A wrapper so that only tables scroll horizontally.
 *
 * Tables in AI output tend to run wide, and left alone the whole body text scrolls
 * horizontally. Moving the start of the body's lines makes it unreadable, so the
 * overflow is confined inside the table.
 */
md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
  `<div class="gera-table">${self.renderToken(tokens, idx, options)}`;
md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`;

/**
 * Sanitization before rendering (§7, mandatory).
 *
 * Feed AI-produced HTML straight into the webview and a single `<script>` reaches the
 * read_file / write_file that host.ts opened up to Rust. The rendering path is an attack
 * surface as it stands.
 *
 * Lean towards an allow-list approach (§7-4 (b)). Stop letting `data-*` through
 * wholesale and allow by name only the three whose meaning we define. Unknown attributes
 * default to the side that gets dropped.
 * The things dropped are named explicitly because the defaults allow a lot:
 * - the `style` element and the style attribute let the document break the type area we
 *   laid out
 * - `target` is an injection of behavior — "where it opens" — and the body text does not
 *   need it
 */
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true }, // SVG and MathML are not allowed through
    ALLOW_DATA_ATTR: false,
    // data-line / data-line-end map back to the raw source (§6);
    // data-math is the placeholder for putting math back after sanitization (MathEnv
    // above).
    ADD_ATTR: ["data-line", "data-line-end", "data-math"],
    FORBID_TAGS: ["style", "form"],
    FORBID_ATTR: ["style", "target"],
  });
}

let lastText: string | null = null;
let body: HTMLElement | null = null;

/**
 * Turn Markdown into HTML and return along with it the math left "to typeset later".
 *
 * Do not split the path between full text and fragments (local editing) — split it and
 * one of them could end up skipping sanitization. Actually typesetting the math is the
 * caller's job.
 */
function build(markdown: string): { html: string; math: (() => string)[]; headings: Heading[] } {
  const env: MathEnv & HeadingEnv = {};
  const html = sanitize(md.render(markdown, env));
  return { html, math: env.math ?? [], headings: env.headings ?? [] };
}

// ---------------------------------------------------------------- Heading list

/**
 * The list of headings (the outline of §9-2).
 *
 * Remember the result from when it was rendered and do not redo the conversion for the
 * same body text. When called from viewer mode, `renderInto` has necessarily run first,
 * so this becomes a path that just returns the remembered array. Called from editor
 * mode, the body text can be newer than what was rendered, and only then is `md.parse`
 * run — `parse`, not `render`. Neither HTML nor KaTeX is needed, only the tokens, so the
 * most expensive part of the conversion (§5-4) goes unpaid.
 */
let headingsText: string | null = null;
let headings: Heading[] = [];

export function listHeadings(markdown: string): Heading[] {
  if (markdown === headingsText) return headings;
  const env: HeadingEnv = {};
  md.parse(markdown, env);
  headingsText = markdown;
  headings = env.headings ?? [];
  return headings;
}

/**
 * Swap a single placeholder for the real equation.
 *
 * For display math the container (`.gera-math`) is already in the right place, so only
 * the content goes in. For inline math the placeholder span itself is redundant, so it
 * is replaced together with KaTeX's output.
 */
function fill(el: HTMLElement, math: (() => string)[]): void {
  const html = math[Number(el.dataset.math)]?.() ?? "";
  delete el.dataset.math;
  if (el.classList.contains("gera-math")) {
    el.innerHTML = html;
    return;
  }
  const box = document.createElement("template");
  box.innerHTML = html;
  el.replaceWith(box.content);
}

/**
 * Turn a single Markdown fragment into HTML. It goes through the same converter and the
 * same sanitization as the full text.
 *
 * This is for block-level local editing, to re-render only the block that changed.
 */
export function renderFragment(markdown: string): string {
  const { html, math } = build(markdown);
  if (!math.length) return html; // With no math at all, nothing needs putting back
  // A fragment is typeset in full on the spot. This is the path for re-rendering the one
  // block fixed by a local edit, and the person being kept waiting is in front of the
  // screen. There is no off-screen part to defer.
  const box = document.createElement("div");
  box.innerHTML = html;
  for (const el of box.querySelectorAll<HTMLElement>("[data-math]")) fill(el, math);
  return box.innerHTML;
}

/**
 * Re-render the body text.
 *
 * Do nothing if the text is unchanged. Going back and forth between viewing and editing
 * is the ordinary way to use this, and most of the time the text has not changed (the
 * responsiveness of §3).
 * The render target element is created and owned by this function — this is the only
 * place that needs to know the shape of viewer mode's DOM, and callers only have to hand
 * over a container.
 */
export function renderInto(scroller: HTMLElement, text: string): void {
  if (!body || body.parentElement !== scroller) {
    scroller.replaceChildren();
    body = document.createElement("article");
    body.className = "gera-doc";
    scroller.append(body);
    lastText = null;
  }
  if (text !== lastText) {
    lastText = text;
    const { html, math, headings: found } = build(text);
    // Remember the headings while rendering. Calling the outline then does not redo the
    // conversion.
    headingsText = text;
    headings = found;
    // Top-level blocks sit flat, directly under .gera-doc. Keep it in a shape where
    // swapping a single block with replaceWith does not break anything (for local
    // editing).
    body.innerHTML = html;
    fillMath(scroller, body, math);
  }
}

// ------------------------------------------------------------ Deferring math

/**
 * Typeset off-screen math only once it comes close.
 *
 * This is the single most expensive move in viewer mode. Breakdown measured on a release
 * build for a document of 2,838 lines / 2,204 equations (ms with JS startup as 0,
 * representative value over n>=2):
 *
 * |                    | with math | math replaced by `<code>` |
 * |---|---|---|
 * | markdown-it + KaTeX | 161 | 27 |
 * | sanitize             |  74 | 62 |
 * | `innerHTML`          |  53 |  7 |
 * | layout               | 523 | 72 |
 * | total                | 930 | 197 |
 *
 * Math accounts for 735 ms. And of those 2,204 equations, only a dozen or so are visible
 * on the first screen. KaTeX's output runs to dozens of nodes per equation (60,325
 * elements / 2.49 MB for this whole document), and `content-visibility: auto` skips
 * layout for off-screen content but does not skip the cost of creating the elements
 * themselves, nor the cost of resolving their styles.
 *
 * So typesetting is delayed. The first few blocks make it into the initial render, and
 * the rest are typeset via IntersectionObserver as they come close. Off-screen blocks
 * are placed using the `contain-intrinsic-size` estimate, so filling in their content
 * does not change their height at that point — which is why typesetting later does not
 * make the type area jump.
 *
 * Text selection is not lost. What is thinned out of the DOM is only the content of the
 * equations; the body blocks are all there from the start (this is not virtualization).
 */

/**
 * How many leading blocks to get into the initial render.
 *
 * One screenful is enough. The rest, the "typeset when it comes close" part, actually
 * makes it into the initial render too — IntersectionObserver's first notification
 * arrives right after that layout and before the paint, and everything within the 200%
 * of `AHEAD` gets typeset there. Typesetting eagerly here is only to settle the first
 * screenful without waiting for that notification; typesetting more than that just
 * front-loads work that will be thrown away.
 *
 * Decided by measurement. Release build, x11 measurement harness (absolute values come
 * out larger than in a real environment), `WEBKIT_DISABLE_DMABUF_RENDERER=1`, conditions
 * interleaved, median time until the body text appears:
 *
 * | EAGER | findings.md (2,838 lines / 2,204 equations, n=7) | rejected.md (956 lines, n=5) |
 * |---|---|---|
 * | 0     |  714 ms |  683 ms |
 * | 8     |  629 ms |  662 ms |
 * | 20    |  695 ms |  689 ms |
 * | 40    |  725 ms |  724 ms |
 * | 60    |  725 ms |    -    |
 * | all (no deferring) | 1,300 ms | 867 ms |
 *
 * Deferring by itself cuts 671 ms. How many leading blocks to typeset is only a
 * difference of about 100 ms within that, but both too many and too few are slower — at
 * 0 there is an extra step waiting for the notification, and at 20 or more we typeset
 * past the edge of the screen. 8 was the minimum for both documents.
 */
const EAGER = 8;

/** The distance at which something counts as close. Typesetting starts two screens ahead. */
const AHEAD = "200% 0px";

/** Math not yet typeset. Grouped per block (rebuilt every time the body is re-rendered). */
let pending = new Map<HTMLElement, HTMLElement[]>();
let pendingMath: (() => string)[] = [];
let watching: IntersectionObserver | null = null;

/** Typeset one block's worth of math right now. Do nothing if we do not hold any. */
function fillBlock(top: HTMLElement): void {
  const slots = pending.get(top);
  if (!slots) return;
  pending.delete(top);
  watching?.unobserve(top);
  for (const el of slots) fill(el, pendingMath);
}

function fillMath(scroller: HTMLElement, body: HTMLElement, math: (() => string)[]): void {
  watching?.disconnect();
  watching = null;
  pending = new Map();
  pendingMath = math;
  if (!math.length) return;

  // Group the placeholders by the "block directly under .gera-doc" they belong to.
  // The unit of deferral is the block because that is the unit content-visibility works
  // on (viewer.css).
  for (const el of body.querySelectorAll<HTMLElement>("[data-math]")) {
    let top: HTMLElement = el;
    while (top.parentElement && top.parentElement !== body) top = top.parentElement;
    const found = pending.get(top);
    if (found) found.push(el);
    else pending.set(top, [el]);
  }
  if (!pending.size) return;

  // The leading portion is typeset on the spot so it makes the initial render.
  for (const top of Array.from(body.children).slice(0, EAGER)) fillBlock(top as HTMLElement);
  if (!pending.size) return;

  watching = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) fillBlock(entry.target as HTMLElement);
    },
    { root: scroller, rootMargin: AHEAD },
  );
  for (const top of pending.keys()) watching.observe(top);
}

// ------------------------------------------------------------ Alignment

/** A heading stuck to the very top edge feels cramped, so lower the target slightly. */
const MARGIN = 24;

/**
 * Scroll and re-measure until the target element reaches the top edge.
 *
 * One pass does not get there. Because of `content-visibility: auto` in viewer.css,
 * off-screen elements are placed at the height of the `contain-intrinsic-size` estimate,
 * so once we scroll there their real heights are settled and the target element shifts by
 * that much. Each re-scroll replaces more estimates with real values, so it converges in
 * a few passes. The iteration count is capped because in places that cannot scroll any
 * further, such as near the end of the document, the error would persist and it would
 * never stop.
 */
function nudge(scroller: HTMLElement, target: HTMLElement): void {
  for (let i = 0; i < 8; i++) {
    const offset =
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - MARGIN;
    if (Math.abs(offset) < 1) return;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + offset;
    if (scroller.scrollTop === before) return; // Reached the edge
  }
}

function settle(scroller: HTMLElement, target: HTMLElement): void {
  nudge(scroller, target);
  // At the destination, the math that was deferred gets typeset. What notices the
  // approach is IntersectionObserver, and that runs just before the next frame's paint
  // (fillMath). If math goes into blocks above the destination, the target element is
  // pushed down by that much. So scroll once more, after the typesetting finishes.
  // rAF is nested two deep because the observer's notification arrives after rAF.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (target.isConnected) nudge(scroller, target);
    });
  });
}

/** The element carrying a line number that is closest to the top edge of the screen, or null. */
function topElement(scroller: HTMLElement): HTMLElement | null {
  const top = scroller.getBoundingClientRect().top;
  let best: HTMLElement | null = null;
  // Since more deeply nested elements come later, the last element satisfying the
  // condition is the finest-grained match.
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-line]")) {
    if (el.getBoundingClientRect().top - top > 1) break;
    best = el;
  }
  return best;
}

/** The source line number (zero-based) currently visible at the top of the screen. */
export function topLine(scroller: HTMLElement): number {
  const el = topElement(scroller);
  return el ? Number(el.dataset.line) : 0;
}

/**
 * Scroll so that the given line comes to the top of the screen.
 *
 * Lines and elements are not one-to-one (one paragraph spans many lines), so we scroll
 * to the element that contains that line, or failing that the last element before it.
 */
export function scrollToLine(scroller: HTMLElement, line: number): void {
  // If we are only returning to the top, skip the re-scroll (settle). The moment we
  // measure, a synchronous layout of the whole document runs, and we pay up front even
  // the off-screen work that content-visibility was supposed to defer. Measured (the
  // 2,204-equation document), time to the first frame grew from 797 ms to 946 ms.
  //
  // Assigning to `scrollTop` also runs a synchronous layout, in order to clamp the value.
  // So for a "freshly rendered container" — one whose scroll position is still 0 — the
  // caller skips this function entirely (enterView in main.ts). The gain measures small,
  // around 15 ms (1,865 → 1,850 ms on the same document, five runs each). What remains
  // here is for the path that reuses the container, that is, when a previously viewed
  // position is still in place.
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
 * Jump to a heading within the same document (§9-1). Returns false if there is no such
 * heading.
 *
 * Reporting the miss back to the caller is because silently doing nothing is the worst
 * outcome (the user has no way to tell why the screen did not move after following a
 * link).
 */
export function scrollToAnchor(scroller: HTMLElement, id: string): boolean {
  // The id comes from the document, so concatenating it as is can produce a broken CSS
  // selector.
  const target = scroller.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!target) return false;
  settle(scroller, target);
  return true;
}
