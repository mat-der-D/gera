/**
 * 編集モード（設計 第4節）。
 *
 * 記号を残したまま装飾のみを当てる。見出しは大きく、太字は太く、引用には縦線を引く。
 * 表や画像は描画せず、Markdown の記法のまま扱う。
 *
 * 実装順序 1 の段階では記号を常に表示する。
 * カーソル行だけ生に戻す規則（第6節）は実装順序 3 で入れる。
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

/** 行そのものに当てる装飾。ブロック要素に対応する。 */
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
 * 範囲に当てる装飾。
 * tok-syntax は記法記号そのもの。消さずに薄くする（第4節「記号を残したまま」）。
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

  // 画面に見えている範囲だけを走る。文書の長さは走査コストに影響しない（第7節）。
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const lineDeco = LINE_DECOS.get(node.name);
        if (lineDeco) {
          const first = doc.lineAt(node.from).number;
          // node.to は次の行頭に来ることがあるため、1 引いてから行を引く。
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

  // 入れ子と重なりがあるため、RangeSetBuilder ではなく sort 付きの set を使う。
  return Decoration.set(ranges, true);
}

const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      // Lezer は構文木を非同期に伸ばすため、木の入れ替わりも再構築の契機に含める。
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

  // 本文以外の常設 UI を持たない（第5節）ので、余白がそのまま画面構成になる。
  // 末尾の大きな余白は、最終行を画面の中ほどまで送れるようにするためのもの。
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

  // 記法記号は消さない。薄くするだけ（第4節）。
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

/** 文書全体を差し替える。ファイルを開いたときと、退避から復帰したときに使う。 */
export function replaceDoc(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 },
    scrollIntoView: true,
  });
}
