/**
 * Syntax highlighting for fenced code blocks (§9-15, implementation order 10 of §14).
 *
 * This module is dynamically imported from viewer.ts, and only for documents that
 * actually contain a fenced code block with a language. Startup speed is the first
 * priority (§4), and viewer mode is the startup path — anything imported statically from
 * viewer.ts is paid for by every document, including the ones with no code in them at
 * all. Measured, this chunk is 89 kB (26 kB gzipped) for the core plus the languages
 * below.
 *
 * highlight.js and not Shiki. The line is where the colors live: "all the colors in CSS"
 * (the owner, 2026-09-05, §9-10). highlight.js emits class names (`hljs-keyword`), so
 * the colors stay in viewer.css and can be replaced from `user.css`. Shiki writes the
 * colors straight into `style` attributes, which pins them on the JS side — and gera's
 * sanitization drops `style` outright (§7-4 (b)).
 *
 * The class names keep highlight.js's own spelling. `docs/CSS.md` says gera adds no
 * class names of its own so that there are fewer names to learn, and this does add some.
 * It is still the right trade: the themes for highlight.js that already exist on the web
 * work as `user.css` unchanged. Rename them and not one of them applies.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * The languages to carry.
 *
 * Chosen by measurement, not by guesswork (§9-15). Counting how many of the owner's
 * 78,231 Markdown files contain a code block in each language: json 4,989 / bash 3,330 /
 * sh 1,343 / markdown 1,264 / yaml 1,064 / js 874 / toml 848 / gs 407 / rust 103 /
 * typescript 78 / css 45 / python 39 / html 23 / latex 10 / sql 9. Everything below that
 * is in single digits.
 *
 * Each module brings its own aliases, and those cover most of what the counts above are
 * spelled as: bash takes `sh`, shell takes `console`, ini takes `toml`, xml takes `html`,
 * javascript takes `js` and `jsx`, typescript takes `ts` and `tsx`, markdown takes `md`,
 * python takes `py`, yaml takes `yml`, rust takes `rs`.
 *
 * `text` is deliberately absent even though it is the second most common of all (3,625
 * files). It means "do not color this", and highlight.js's `plaintext` would only escape
 * the source and hand back the same thing. Not registering it makes `highlight` below
 * return null, and the block is left exactly as the sanitizer produced it.
 */
for (const [name, language] of Object.entries({
  bash,
  css,
  diff,
  ini,
  javascript,
  json,
  markdown,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, language);
}

// `gs` is Google Apps Script — JavaScript under another name, and 407 files' worth of it.
// `jsonc` is JSON with comments; highlight.js has no separate mode for it, and JSON's is
// close enough that the comments are the only thing not colored.
hljs.registerAliases(["gs"], { languageName: "javascript" });
hljs.registerAliases(["jsonc"], { languageName: "json" });

/**
 * Color one block of code. Returns null if we do not carry that language.
 *
 * Returning null rather than falling back to `highlightAuto` is on purpose. Auto
 * detection runs every registered language over the source and picks a winner, which is
 * both the most expensive thing in the library and, on the short blocks that fill AI
 * output, frequently wrong. Coloring a block as the wrong language is worse than leaving
 * it black.
 *
 * The result is safe to assign to `innerHTML`: highlight.js escapes the source it is
 * given, and everything it adds is `<span class="hljs-…">`. It is our own output, so it
 * does not go through sanitization (the same standing as KaTeX in viewer.ts) — but
 * unlike KaTeX's, it would survive sanitization unchanged, and it is only skipped here
 * because there is nothing left to check.
 */
export function highlight(code: string, language: string): string | null {
  if (!hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    // A language mode throwing must not take the document with it. The block stays
    // black, which is exactly what it looked like a moment earlier.
    return null;
  }
}
