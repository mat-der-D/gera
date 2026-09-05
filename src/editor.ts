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
import { EditorState } from "@codemirror/state";
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
