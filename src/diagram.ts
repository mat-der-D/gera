/**
 * Mermaid diagrams (§9-15, implementation order 11 of §14).
 *
 * Dynamically imported from viewer.ts, and not when the document merely contains a
 * diagram — only once one of them comes near the screen. Bundled, mermaid is 4.40 MB
 * across 99 chunks, against 1.4 MB for the whole of the rest of gera, and it is wanted by
 * 42 of the owner's 78,231 Markdown files (§9-15). Nothing about the first priority
 * (§4) survives loading that up front.
 *
 * The size is paid in the installer and nowhere else. mermaid loads the code for a
 * diagram type only when it meets one, so a document with a flowchart in it never
 * touches the chunks for the twenty other kinds.
 *
 * Colours come from CSS, like everything else ("all the colours in CSS", the owner,
 * 2026-09-05, §9-10). mermaid decides its colours in JS and bakes them into a <style>
 * inside the SVG, so the way to keep the promise is to read gera's own custom properties
 * at render time and hand them over as `themeVariables`. That is also what makes
 * `presets/dark.css` work on a diagram: it sets those same properties.
 */
import mermaid from "mermaid";

/** Read one custom property off the root element. */
function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

/**
 * Build mermaid's theme out of gera's palette.
 *
 * `theme: "base"` is the only one of mermaid's themes that takes `themeVariables` as the
 * whole story; the others layer their own colours on top and would show through wherever
 * a name below is missing.
 *
 * The names are mermaid's, and there are many more of them than this. What is set here
 * is the set that the diagram types the owner actually writes reach for — flowchart,
 * sequence, class, state and ER (§9-15). Anything not named falls back to mermaid's own
 * base theme, which is light; if a diagram type shows up with pale patches on a dark
 * ground, this is the list to add to.
 */
function palette(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const bg = token(style, "--bg", "#faf8f4");
  const fg = token(style, "--fg", "#23211d");
  const dim = token(style, "--dim", "#a9a196");
  const rule = token(style, "--rule", "#ddd6ca");
  const face = token(style, "--code-bg", "#f0ece3");
  const zebra = token(style, "--zebra", "#f4f1ea");
  return {
    background: bg,
    // Nodes and boxes take the same ground as code blocks and table headers. A diagram
    // is then one more thing on the page rather than a picture pasted onto it.
    primaryColor: face,
    mainBkg: face,
    secondaryColor: zebra,
    tertiaryColor: zebra,
    primaryTextColor: fg,
    secondaryTextColor: fg,
    tertiaryTextColor: fg,
    textColor: fg,
    titleColor: fg,
    primaryBorderColor: rule,
    secondaryBorderColor: rule,
    tertiaryBorderColor: rule,
    nodeBorder: rule,
    clusterBkg: zebra,
    clusterBorder: rule,
    lineColor: dim,
    // A label sitting on an edge needs the page's ground behind it, not the node's, or
    // the line shows through the letters.
    edgeLabelBackground: bg,
    actorBkg: face,
    actorBorder: rule,
    actorTextColor: fg,
    actorLineColor: dim,
    signalColor: fg,
    signalTextColor: fg,
    labelBoxBkgColor: face,
    labelBoxBorderColor: rule,
    labelTextColor: fg,
    loopTextColor: fg,
    noteBkgColor: zebra,
    noteTextColor: fg,
    noteBorderColor: rule,
    altBackground: zebra,
  };
}

/** Apply the current palette. Called before every render, so `Mod+,` takes effect. */
function configure(): void {
  const style = getComputedStyle(document.documentElement);
  mermaid.initialize({
    // gera draws when it decides to, not when the page loads.
    startOnLoad: false,
    theme: "base",
    themeVariables: palette(),
    // The diagram is text as much as the body is, so it uses the same face as the
    // banner and the rest of the interface rather than mermaid's default sans stack —
    // which carries no Japanese face and would fall back per glyph.
    fontFamily: token(style, "--font-sans", "sans-serif"),
    // The source comes out of the document, which is to say out of an AI's output
    // (§7-1). At this level mermaid sanitizes the labels itself and refuses the
    // click-handler and script directives its syntax allows.
    securityLevel: "strict",
  });
}

let counter = 0;

/**
 * Draw one diagram. Returns the SVG, or throws if the source will not parse.
 *
 * mermaid needs the element in the document to measure text, so it appends a temporary
 * one of its own during the call. On a parse error it can leave that behind, which is
 * why the id is remembered and swept up here rather than left to accumulate one stray
 * element per broken diagram.
 */
export async function draw(source: string): Promise<string> {
  configure();
  const id = `gera-mermaid-${counter++}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}
