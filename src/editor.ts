/**
 * Edit mode (see DESIGN.md §4).
 *
 * The markers are left in place and only styling is applied: headings get larger,
 * bold gets bolder, quotes get a vertical rule. Tables and images are not rendered;
 * they are kept as Markdown notation.
 *
 * At implementation step 1 the markers are always shown. The rule that reverts only
 * the cursor's line to raw text (§6) comes in at implementation step 3.
 */
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import type { Extension, Range } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { syntaxTree } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";

/** Decorations applied to the line itself. These correspond to block elements. */
const LINE_CLASSES: Record<string, string> = {
  ATXHeading1: "tok-h1",
  ATXHeading2: "tok-h2",
  ATXHeading3: "tok-h3",
  ATXHeading4: "tok-h4",
  ATXHeading5: "tok-h5",
  ATXHeading6: "tok-h6",
  SetextHeading1: "tok-h1",
  SetextHeading2: "tok-h2",
  Blockquote: "tok-quote",
  FencedCode: "tok-codeblock",
  CodeBlock: "tok-codeblock",
  HorizontalRule: "tok-hr",
};

/**
 * Decorations applied to a range.
 * tok-syntax is the notation markers themselves. They are dimmed, not removed
 * (§4, 「記号を残したまま」 — "with the markers left in place").
 */
const MARK_CLASSES: Record<string, string> = {
  HeaderMark: "tok-syntax",
  EmphasisMark: "tok-syntax",
  CodeMark: "tok-syntax",
  QuoteMark: "tok-syntax",
  LinkMark: "tok-syntax",
  StrikethroughMark: "tok-syntax",
  CodeInfo: "tok-syntax",
  TableDelimiter: "tok-syntax",
  ListMark: "tok-listmark",
  StrongEmphasis: "tok-strong",
  TableHeader: "tok-strong",
  Emphasis: "tok-em",
  Strikethrough: "tok-strike",
  InlineCode: "tok-code",
  URL: "tok-url",
};

const LINE_DECOS = new Map<string, Decoration>(
  Object.entries(LINE_CLASSES).map(([name, cls]) => [name, Decoration.line({ class: cls })]),
);
const MARK_DECOS = new Map<string, Decoration>(
  Object.entries(MARK_CLASSES).map(([name, cls]) => [name, Decoration.mark({ class: cls })]),
);

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const seen = new Set<string>();
  const { doc } = view.state;

  // Walk only the ranges visible on screen. The length of the document does not
  // affect the cost of the walk (§7).
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const lineDeco = LINE_DECOS.get(node.name);
        if (lineDeco) {
          const first = doc.lineAt(node.from).number;
          // node.to can land at the start of the next line, so subtract 1 before
          // looking up the line.
          const last = doc.lineAt(Math.max(node.from, node.to - 1)).number;
          for (let n = first; n <= last; n++) {
            const key = `${n} ${node.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            ranges.push(lineDeco.range(doc.line(n).from));
          }
        }

        const markDeco = MARK_DECOS.get(node.name);
        if (markDeco && node.to > node.from) ranges.push(markDeco.range(node.from, node.to));
      },
    });
  }

  // Ranges nest and overlap, so use a sorting set rather than RangeSetBuilder.
  return Decoration.set(ranges, true);
}

const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      // Lezer extends the syntax tree asynchronously, so a swap of the tree also
      // counts as a trigger for rebuilding.
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--fg)", fontSize: "16px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.9", overflowY: "auto" },

  // There is no permanent UI other than the text (§5), so the padding is itself the
  // composition of the screen. The large padding at the end is there so the last
  // line can be scrolled up to the middle of the screen.
  ".cm-content": {
    maxWidth: "42em",
    margin: "0 auto",
    padding: "3.5rem 1.5rem 60vh",
    caretColor: "var(--fg)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--sel)",
  },

  ".tok-h1": { fontSize: "1.75em", fontWeight: "700", lineHeight: "1.5" },
  ".tok-h2": { fontSize: "1.45em", fontWeight: "700", lineHeight: "1.55" },
  ".tok-h3": { fontSize: "1.25em", fontWeight: "700", lineHeight: "1.6" },
  ".tok-h4": { fontSize: "1.1em", fontWeight: "700" },
  ".tok-h5": { fontWeight: "700" },
  ".tok-h6": { fontWeight: "700", color: "var(--dim)" },
  ".tok-quote": { borderLeft: "3px solid var(--rule)", paddingLeft: "0.8em", color: "var(--dim)" },
  ".tok-codeblock": {
    fontFamily: "var(--font-mono)",
    backgroundColor: "var(--code-bg)",
    fontSize: "0.9em",
  },
  ".tok-hr": { color: "var(--dim)" },

  // Notation markers are never removed, only dimmed (§4).
  ".tok-syntax": { color: "var(--dim)", fontWeight: "400" },
  ".tok-listmark": { color: "var(--accent)" },
  ".tok-strong": { fontWeight: "700" },
  ".tok-em": { fontStyle: "italic" },
  ".tok-strike": { textDecoration: "line-through", color: "var(--dim)" },
  ".tok-code": {
    fontFamily: "var(--font-mono)",
    backgroundColor: "var(--code-bg)",
    fontSize: "0.92em",
  },
  ".tok-url": { color: "var(--accent)", textDecoration: "underline" },
});

/**
 * Turn a page in edit mode. `PageUp` / `PageDown`, and the second spellings
 * `Mod+↑↓` / `Mod+J` `Mod+K` (§9-13).
 *
 * This is the same operation as `scrollViewByPage` in main.ts, and it has to move by
 * the same amount: one screen minus one line, so the eye has a line to land on. Left to
 * CodeMirror's `cursorPageUp` / `cursorPageDown`, edit mode moved by a whole screen with
 * no overlap, and carried the cursor rather than the paper — so one key meant two
 * different amounts depending on the mode. main.ts already refuses that for two
 * spellings of one operation; the same refusal has to hold across the two modes.
 *
 * The cursor rides along, and the paper is scrolled by the distance the cursor actually
 * travelled — not by the distance the keys asked for. The cursor lands on a line, so the
 * two differ, and paying the difference out of the scroll walks the cursor up or down the
 * window one press at a time (measured: 25.6px on a single `PageDown`). It is the defect
 * §9-11 records for the tracker's band (125px over four presses), in the same shape.
 *
 * Scrolling without the cursor was the other option and is worse — the cursor is left
 * behind, and the next keystroke yanks the paper back to it.
 *
 * Measured (980×760, a 673px scroller): `PageDown`, `PageUp`, `Mod+↑↓` and `Mod+J`/`K`
 * all move 638px, one press down and one press back returns to the same line with the
 * scroll where it started, and five presses walk the cursor 1.0px in the window. View
 * mode moves 640px in the same window — the same rule, on a line 33.1px tall instead of
 * 30.4px.
 *
 * At the end of the document the cursor stops, so the distance goes to zero and the paper
 * stops with it.
 */
function pageBy(view: EditorView, dir: 1 | -1): boolean {
  const line = view.defaultLineHeight;
  // Counted in lines, not pixels. Asking `moveVertically` for a distance in pixels lands
  // on whichever line covers that point, and it rounds differently going up than going
  // down: measured, one `PageDown` moved 638px and the `PageUp` after it moved 612px, so
  // a round trip did not come back to where it started. Moving a fixed number of lines
  // cannot be asymmetric — the way back crosses the same lines.
  //
  // One line short of a screenful, so a line of the screen being left stays on screen for
  // the eye to land on (the same rule as `scrollViewByPage` in main.ts).
  const lines = Math.max(Math.floor(view.scrollDOM.clientHeight / line) - 1, 1);
  const range = view.state.selection.main;
  let moved = range;
  for (let i = 0; i < lines; i++) moved = view.moveVertically(moved, dir === 1);
  // Both positions are on screen — `moveVertically` had to lay the target out to find it
  // — so this is measured before the scroll, while both are still rendered.
  const from = view.coordsAtPos(range.head);
  const to = view.coordsAtPos(moved.head);
  view.dispatch({ selection: EditorSelection.create([moved]) });
  view.scrollDOM.scrollTop += from && to ? to.top - from.top : dir * lines * line;
  return true;
}

/**
 * Placed above `defaultKeymap`, which binds `PageUp` / `PageDown` to the commands that
 * move the cursor by a whole screen. `Prec.high` rather than mere ordering, so that this
 * does not depend on where the extension happens to sit in the array.
 */
const pageKeys = Prec.high(
  keymap.of([
    { key: "PageDown", run: (v) => pageBy(v, 1) },
    { key: "PageUp", run: (v) => pageBy(v, -1) },
    { key: "Mod-ArrowDown", run: (v) => pageBy(v, 1) },
    { key: "Mod-ArrowUp", run: (v) => pageBy(v, -1) },
    { key: "Mod-j", run: (v) => pageBy(v, 1) },
    { key: "Mod-k", run: (v) => pageBy(v, -1) },
  ]),
);

export function createEditor(
  parent: HTMLElement,
  commands: Extension,
  onChange: (text: string) => void,
): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        highlightSpecialChars(),
        rectangularSelection(),
        markdown({ extensions: [GFM] }),
        EditorView.lineWrapping,
        decorations,
        theme,
        commands,
        pageKeys,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
}

/** Replaces the whole document. Used when a file is opened and when restoring from
 * the auto-saved session. */
export function replaceDoc(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 },
    scrollIntoView: true,
  });
}
