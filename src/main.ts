// Types for `import "./style.css"`. vite brings the `*.css` declarations in here.
/// <reference types="vite/client" />

/**
 * Startup, and the entry and exit points for the document text. Implementation
 * order 1 and 2 of DESIGN.md §9.
 *
 * At startup we load view mode only. gera is mostly a viewer (§1), and the place
 * a launch lands is view mode too. Edit mode (CodeMirror) is loaded only when
 * `Mod+E` is pressed, or when we start with an empty document (`ensureEditor` in
 * this file). The reverse arrangement — making the viewer a dynamic import and
 * putting CodeMirror in the initial chunk — would mean loading code that that
 * particular launch never uses, every single time.
 *
 * So the authoritative copy of the document text lives in `text` in this file,
 * not in CodeMirror. Launches with no CodeMirror at all are routine, so the text
 * cannot be entrusted to it.
 */
import "./style.css";
import * as viewer from "./viewer";
import type { EditorView } from "@codemirror/view";
import {
  copyToClipboard,
  fileDigest,
  initialPath,
  loadSession,
  openExternal,
  pickFileToOpen,
  pickPathToSave,
  readFile,
  readUserCss,
  saveSession,
  setWindowTitle,
  writeFile,
} from "./host";
import { reportFontResolution } from "./fonts";
// Type-only import. The implementation is loaded through a dynamic import and
// nothing else, so the find UI stays out of the initial startup chunk (see
// toggleFind below).
import type { FindMatch } from "./find";

/** The authoritative document text. Launches without CodeMirror exist, so it cannot live there. */
let text = "";
let currentPath: string | null = null;
let dirty = false;

/**
 * Which file, and which version of it, the current text came from (§9-6).
 *
 * On a successful read or save, the digest of the content at that moment (a
 * string produced on the Rust side) goes here. External modifications are found
 * by comparing this against what is on disk right now. We compare content, not
 * mtime — mtime moves even when the content is identical, which produces false
 * alarms (fileDigest in host.ts).
 *
 * `null` means text that did not come from a file (untitled, or restored from
 * the stash). There is nothing to compare against, so we neither detect nor
 * refuse anything.
 */
let baseDigest: string | null = null;

/**
 * Whether the external modification has already been announced (§9-6).
 *
 * Re-showing the banner every time focus returns means it appears every time
 * until you reload, which is noisy. We announce only the first time the mismatch
 * is found, and clear it once the file is reloaded or saved.
 */
let externalChanged = false;
// Which mode we land in is undecided until the stash has been read. A document
// with content lands in view mode, an empty one in edit mode (see the startup
// code at the end of this file).
let mode: "edit" | "view" = "view";

// ---------------------------------------------------------- failure notification

/**
 * There is no permanent UI (§5), so there is nowhere on screen to report a failure.
 *
 * We always log to the console, and additionally show a banner at the bottom of
 * the screen that disappears after a few seconds. It is not permanent, does not
 * touch the document text, and takes no space away from it, so it does not
 * violate §5. The banner reports only results that are invisible on screen. A
 * successful save is already visible as the bullet disappearing from the title
 * bar, so it stays silent. Copying to the clipboard changes nothing on screen
 * even when it succeeds, so staying silent would leave the user unable to tell
 * whether anything happened.
 */
let noticeTimer: number | undefined;

function notify(message: string): void {
  let bar = document.getElementById("notice");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "notice";
    // style.css only owns the background color and the typefaces (see the top of
    // that file), so the appearance of this transient element lives here. The
    // colors borrow the variables so it does not float off the document.
    bar.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:1.5rem",
      "transform:translateX(-50%)",
      "max-width:36em",
      "padding:0.5em 1em",
      "font:0.85rem/1.6 var(--font-sans)",
      "color:var(--dim)",
      "background:var(--code-bg)",
      "border:1px solid var(--rule)",
      "border-radius:4px",
      "pointer-events:none",
      "white-space:pre-wrap",
    ].join(";");
    document.body.append(bar);
  }
  bar.textContent = message;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => bar.remove(), 5000);
}

/** Never fire an async task and forget it. Swallowing the error makes a failed save look like a success. */
function run(what: string, task: () => Promise<void>): void {
  void task().catch((e: unknown) => {
    console.error(`[gera] ${what}に失敗`, e);
    notify(`${what}に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  });
}

// -------------------------------------------------------------- title and stash

/** Split on both path separators, because Windows is a distribution target (§1). */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

let lastTitle: string | null = null;

/**
 * The only dirty marker is the leading bullet.
 * The title bar belongs to the OS, so state display can be offloaded there
 * (setWindowTitle in host.ts).
 *
 * setWindowTitle costs a round trip of IPC to Rust. This function is called on
 * every keystroke — during IME composition, several times before a single
 * character is even committed — but the title is determined solely by
 * currentPath and dirty, and for most of those calls it does not change. So we
 * remember the last string sent and send only when it actually changed.
 */
let titleQueue: Promise<void> = Promise.resolve();

function refreshTitle(): void {
  const name = currentPath ? baseName(currentPath) : "無題";
  const title = `${dirty ? "• " : ""}${name} — gera`;
  if (title === lastTitle) return;
  lastTitle = title;
  // Send them in order. setWindowTitle is IPC, so firing and forgetting gives no
  // guarantee about arrival order. Measured (2026-09-04, WAYLAND_DEBUG): what
  // the JS side sent as "無題 → probe.md" arrived as "probe.md → 無題", and the
  // correct title was overwritten by the stale one.
  titleQueue = titleQueue
    .then(() => setWindowTitle(title))
    .catch((e: unknown) => console.error("[gera] タイトルの更新に失敗", e));
}

// ------------------------------------------ surface state in the document area too

/**
 * The title bar cannot be relied on (2026-09-04).
 *
 * `refreshTitle` above does send `• DESIGN.md — gera` correctly, and
 * `xdg_toplevel.set_title` has been confirmed to go out with `WAYLAND_DEBUG=1`.
 * Even so, on the owner's own environment (native Wayland / GNOME) it is drawn
 * as the initial `gera` (confirmed by screenshot). Forcing `GDK_BACKEND=x11`
 * makes it appear correctly, so this is GTK and mutter territory and the app
 * cannot reach it. Escaping to X11 is not an option — it costs 560 ms more on a
 * cold start (§5-8).
 *
 * Keep the title setting; do not remove it. It works on X11, and it is expected
 * to work on Windows. What we add here is a second path for the environments
 * where it does not work.
 *
 * There are two things to surface, and since they differ in nature they take
 * different forms.
 *
 * - Whether there are unsaved changes (`.gera-dirty`) — this has to be in view
 *   even while reading. A single thin line at the top edge of the window. It
 *   takes no width from the document and is noticeable without looking away
 * - Which file this is, and that `F1` exists (`.gera-file`) — always shown in the
 *   top left of the screen (`refreshFileLabel` below)
 */
function refreshStatus(): void {
  refreshTitle();
  refreshDirtyMark();
  refreshFileLabel();
  refreshEmptyHint();
}

/** The unsaved marker. Not created until it is needed — a launch that only reads never creates it. */
let dirtyMark: HTMLElement | null = null;

function refreshDirtyMark(): void {
  if (!dirty && !dirtyMark) return;
  if (!dirtyMark) {
    dirtyMark = document.createElement("div");
    dirtyMark.className = "gera-dirty";
    document.body.append(dirtyMark);
    return; // dirty by definition at creation time. Visible by default, so leave it alone
  }
  // This is called on every keystroke. Writing an attribute even with the same
  // value forces style recalculation, so touch it only when it changed (this
  // upholds "no frames are produced while at rest" from §5-10).
  if (dirtyMark.hidden === !dirty) return;
  dirtyMark.hidden = !dirty;
}

/**
 * Always show the name of the open file, and the hint that `F1` exists, in the
 * top left of the screen.
 *
 * Changed to a permanent element on 2026-09-04 at the owner's instruction
 * (verbatim):
 *
 * > 「左上に常に表示されているほうがいいですね。
 * > なんなら**ファイル名も上部にずっと表示されてる**ほうがいいかも。」
 * > ("Having it always shown in the top left would be better. Actually, having
 * > the file name permanently at the top would be good too.")
 *
 * Until then it lived in two places depending on the mode — at the head of the
 * document flow on the view side, absolutely positioned inside `.cm-scroller` on
 * the edit side — and in both cases it scrolled away after a little scrolling.
 *
 * This is a decision to relax "no permanent UI other than the document text"
 * from DESIGN.md §9. §9 has already been corrected to say it is "the starting
 * point of the first version, not a permanent prohibition", and this sits inside
 * the owner's stated direction: "build it that simply as a start, then add
 * features little by little". That said, since it is permanent, the cost is kept
 * minimal — it does not narrow the text column at all (`position: fixed` puts it
 * outside the column), it does not hide the start of the document, and it has a
 * background so scrolled text does not overlap its characters. Details are
 * written on the style.css side.
 *
 * Because it is fixed to the window, it has the same position and the same
 * appearance in both view and edit mode. With a single place to live, the
 * injection into the document on the `viewer.ts` side is gone too — which also
 * frees up one of the eager rendering slots (`EAGER = 8`) it had been consuming.
 *
 * The element is created once and only its contents are swapped afterwards. This
 * function is called on every keystroke — during IME composition, several times
 * before a single character is even committed — so do not touch the DOM when
 * nothing changed (this upholds "no frames are produced while at rest" from
 * §5-10).
 *
 * The full path goes into the `title` attribute. It is too long to show in the
 * top left, but a way to check which file this actually is, is still needed.
 */
let fileLabel: HTMLElement | null = null;
let fileLabelName: HTMLElement | null = null;
let fileLabelTip: HTMLElement | null = null;
/** The name currently in the label. `undefined` means "never set at all" — without
 * distinguishing it from `null` (untitled), a launch that starts untitled fails to
 * collapse the name box. */
let shownFileName: string | null | undefined;

function refreshFileLabel(): void {
  if (!fileLabel) {
    fileLabel = document.createElement("div");
    fileLabel.className = "gera-file";
    fileLabelName = document.createElement("span");
    fileLabelName.className = "gera-file-name";
    fileLabelTip = document.createElement("span");
    fileLabelTip.className = "gera-keys-tip";
    fileLabelTip.textContent = "F1 キー一覧";
    fileLabel.append(fileLabelName, fileLabelTip);
    document.body.append(fileLabel);
  }
  const name = currentPath ? baseName(currentPath) : null;
  if (name === shownFileName) return;
  shownFileName = name;
  if (!fileLabelName) return;
  fileLabelName.textContent = name ?? "";
  // When untitled, collapse the whole name box. Leaving an empty box behind
  // leaves the flex gap (1.4em) in place and shifts the hint to the right for no
  // reason. The hint itself is shown even when untitled — having no file name is
  // not a reason to withhold `F1`, and if anything, someone starting untitled is
  // likely to be someone launching for the first time (§3).
  fileLabelName.hidden = !name;
  if (currentPath) fileLabel.title = currentPath;
  else fileLabel.removeAttribute("title");
}

/**
 * Collapse the top-left hint only while the unobtrusive key list for an empty
 * document (`.gera-keys-hint`) is showing.
 *
 * Do not say the same thing twice. The list already contains a row for `F1`, and
 * showing "F1 キー一覧" directly above it conveys nothing more. It comes back
 * once the list is gone.
 */
function refreshTipVisibility(hintShown: boolean): void {
  if (!fileLabelTip) return;
  if (fileLabelTip.hidden === hintShown) return; // a path taken on every keystroke
  fileLabelTip.hidden = hintShown;
}

let stashTimer: number | undefined;

/**
 * The invisible automatic stash (§11). Its only job is to close off the path
 * where a crash loses everything, so success or failure is not surfaced in the
 * UI. To avoid writing on every keystroke, it runs once after things go quiet.
 */
function scheduleStash(latest: string): void {
  window.clearTimeout(stashTimer);
  stashTimer = window.setTimeout(() => {
    void saveSession({ path: currentPath, text: latest }).catch((e: unknown) => {
      // A failed stash is not a response to any user action, so no banner — leave it in the log only.
      console.error("[gera] 自動退避に失敗", e);
    });
  }, 800);
}

// ------------------------------------------------------------ deferring edit mode

/**
 * Load the whole edit mode (CodeMirror), and create it if it does not exist yet.
 *
 * Never called at startup. It is called only by `Mod+E`, and when we start with
 * an empty document. `@codemirror/view` is taken dynamically as a whole
 * namespace because `EditorView.scrollIntoView` is a runtime value. It lands in
 * the same chunk as `./editor`, so it costs nothing extra.
 */
let view: EditorView | null = null;
let cm: typeof import("@codemirror/view") | null = null;

async function ensureEditor(app: HTMLElement): Promise<EditorView> {
  if (view) return view;
  const [cmView, editor] = await Promise.all([import("@codemirror/view"), import("./editor")]);
  cm = cmView;
  // Push the user CSS back behind the CSS that just arrived late.
  raiseUserCss();
  // Inserting the text runs updateListener and raises dirty. Merely moving the
  // content across must not mean "modified" — whether the state is unsaved is
  // determined by the history on the text side.
  const was = dirty;
  const created = editor.createEditor(app, [], (latest) => {
    text = latest;
    dirty = true;
    refreshStatus();
    scheduleStash(latest);
  });
  if (text) editor.replaceDoc(created, text);
  dirty = was;
  view = created;
  refreshStatus();
  return created;
}

// ------------------------------------------------------------------- commands

function appElement(): HTMLElement {
  const app = document.getElementById("app");
  if (!app) throw new Error("#app が無い");
  return app;
}

async function openFile(): Promise<void> {
  const path = await pickFileToOpen();
  if (!path) return; // cancelling is not a failure
  const loaded = await readFile(path);
  text = loaded.text;
  currentPath = path;
  baseDigest = loaded.digest;
  externalChanged = false;
  dirty = false;
  refreshStatus();
  if (view) {
    const editor = await import("./editor");
    editor.replaceDoc(view, loaded.text);
    // replaceDoc calls onChange synchronously, so clear dirty afterwards.
    dirty = false;
    refreshStatus();
  }
  // Once a document is loaded, show it in view mode (§1, "mostly a viewer").
  // Treat this the same as the restore at startup (below) — if the landing place
  // differs depending on how the document got in, the user is forced to think
  // about modes.
  await enterView(0);
}

/**
 * Save (§9-3, §9-6).
 *
 * Saving over an existing file is refused if it was modified externally. Writing
 * anyway erases the other party's changes, and nobody notices that they are
 * gone. The comparison is done on the Rust side immediately before the write
 * (the `expect` argument of writeFile in host.ts) — asking here and then writing
 * would miss whatever was written in the gap.
 *
 * Save As (`Mod+Shift+S`) does not compare. It is the only way out when there is
 * a mismatch, so blocking it here would leave no escape. Whether overwriting is
 * acceptable when the same name is picked again has already been settled by the
 * OS save dialog asking "replace?".
 */
async function saveFile(forcePicker: boolean): Promise<void> {
  const path = forcePicker || !currentPath ? await pickPathToSave(currentPath) : currentPath;
  if (!path) return;
  // There is something to compare against only when overwriting the file that is currently open.
  const expect = !forcePicker && path === currentPath ? baseDigest : null;
  const written = await writeFile(path, text, expect);
  if (written.kind === "conflict") {
    externalChanged = true;
    // Spell out all three ways out. Reporting only the refusal without showing
    // what to do next leaves the user stuck holding a document that "cannot be
    // saved". All three are keys that already exist — do not invent a new
    // spelling here (§4, second priority).
    notify(
      "外部で書き換えられているため保存しませんでした。\n" +
        "Mod+R … 相手のを取る（自分の編集は失われます）\n" +
        "Mod+Shift+S … 別名で保存して両方残す\n" +
        "Mod+Shift+S で同じ名前を選ぶ … 自分のを残す（置き換えるか OS が訊きます）",
    );
    return;
  }
  // Clear dirty only when no exception was thrown. Do not treat a failure as a success.
  currentPath = path;
  // Make what we just wrote the new baseline. Otherwise the next `Mod+S`
  // mistakes our own write for an external modification.
  baseDigest = written.digest;
  externalChanged = false;
  dirty = false;
  refreshStatus();
}

// ------------------------------------------------------------ switching modes

let scroller: HTMLElement | null = null;

/**
 * Behave differently depending on where a link points (§7-4 (d), §9-1).
 *
 * Whatever the destination, first stop the navigation itself. If the webview
 * navigates away to an external site, both the document and the app vanish from
 * the screen with no way back. On top of that,
 *
 * - `#…` scrolls to a heading within the same document
 * - anything else is handed to Rust's `open_external`. Do not inspect the scheme
 *   here. The decision to allow only `http` and `https` belongs to the Rust side
 *   (§7-4 (d)). Writing the same decision here as well creates the illusion that
 *   the frontend is what is guarding it — if the webview is taken over, the
 *   invoke goes out directly and not one of the checks on this side runs. Unless
 *   a decision has exactly one home, it stops being clear which copy is
 *   authoritative. What is refused (`file:`, and relative links to other files —
 *   the latter is out of scope for §10) comes back as a failure from the Rust
 *   side, which surfaces in the banner below
 */
function onLinkClick(e: MouseEvent): void {
  const link = e.target instanceof Element ? e.target.closest("a") : null;
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute("href");
  if (!href) return;

  if (href.startsWith("#")) {
    // A heading id is the literal spelling from the document, so undo the URL encoding before passing it on.
    const id = decodeURIComponent(href.slice(1));
    if (!scroller) return;
    if (!viewer.scrollToAnchor(scroller, id)) notify(`この文書に見出し「${id}」がありません`);
    return;
  }

  run("リンクを開く操作", () => openExternal(href));
}

function viewerElement(): HTMLElement {
  if (scroller) return scroller;
  const el = document.createElement("div");
  el.className = "gera-view";
  // View mode has no cursor (§4), so as it stands there is nothing on screen to
  // receive the arrow keys or PageDown. Make it focusable and leave the
  // scrolling itself to the webview.
  el.tabIndex = 0;
  el.addEventListener("click", onLinkClick);
  document.body.append(el);
  scroller = el;
  return el;
}

/** The line visible at the top of the screen in edit mode (0-based, matching data-line on the view side). */
function editorTopLine(v: EditorView): number {
  const rect = v.scrollDOM.getBoundingClientRect();
  const pos = v.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 1 }, false);
  return v.state.doc.lineAt(pos).number - 1;
}

/** Whether the container has ever been put on screen. If not, its scroll position is still 0. */
let shown = false;

/**
 * Enter view mode, showing `line` (0-based) at the top of the screen.
 *
 * This is also the path taken right after a document is loaded (the restore at
 * startup, and openFile).
 */
function enterView(line: number): void {
  const el = viewerElement();
  // Positioning requires measuring, so put it on screen before drawing.
  el.hidden = false;
  appElement().hidden = true;
  mode = "view";
  // A container that has never been on screen still has scroll position 0.
  // Assigning to `scrollTop` runs a synchronous layout in order to clamp the
  // value, so do not touch it when there is no need to write 0. The measured
  // gain is small, but there is no reason not to do it either.
  const fresh = !shown;
  shown = true;
  viewer.renderInto(el, text);
  if (line > 0 || !fresh) viewer.scrollToLine(el, line);
  // The key list for an empty document lives inside the edit-mode container.
  // Moving to view mode hides it, so bring the top-left hint back (paired with
  // enterEdit below).
  refreshEmptyHint();
  // focus() by default tries to scroll the target into view, which measures. Stop it for the same reason as above.
  el.focus({ preventScroll: true });
}

/**
 * Put `line` (0-based) at the top of the screen in edit mode.
 *
 * While hidden, and right after a font size change, the measurements are stale,
 * so re-measure before scrolling.
 */
function scrollEditorToLine(v: EditorView, line: number): void {
  // The top is the top edge, not "line 1 pushed down by 24px". Passing line 0 to
  // scrollIntoView scrolls so that only 24px of the top padding (3.5rem)
  // remains, hiding 32px of the head of the container. Match what scrollToLine
  // on the view side does, treating `line <= 0` as `scrollTop = 0` — without
  // matching, the file name placed in the top padding is half cut off in edit
  // mode only.
  if (line <= 0) {
    v.scrollDOM.scrollTop = 0;
    return;
  }
  v.requestMeasure();
  const target = v.state.doc.line(Math.min(line + 1, v.state.doc.lines));
  // ensureEditor always fills cm in. It is only nullable at the type level.
  if (!cm) return;
  v.dispatch({
    effects: cm.EditorView.scrollIntoView(target.from, { y: "start", yMargin: 24 }),
  });
}

/** Enter edit mode, putting the line that was at the top in view mode at the top here too (§9-3). */
async function enterEdit(): Promise<void> {
  const app = appElement();
  const line = shown && scroller ? viewer.topLine(scroller) : 0;
  const v = await ensureEditor(app);
  if (scroller) scroller.hidden = true;
  app.hidden = false;
  mode = "edit";
  refreshEmptyHint();
  scrollEditorToLine(v, line);
  v.focus();
}

/**
 * Switching modes (§5). To satisfy "in both directions, what you were looking at
 * stays visible", the position is handed over as a line number. Paragraphs and
 * lines are not one-to-one so it will not match exactly, but it returns to the
 * vicinity of the same heading.
 */
async function toggleMode(): Promise<void> {
  if (mode === "edit") enterView(view ? editorTopLine(view) : 0);
  else await enterEdit();
}

// ------------------------------------------------------------ jumping to headings

/**
 * The line currently visible at the top of the screen (0-based). It means the
 * same thing regardless of mode. Positions are exchanged through a single
 * mechanism, the line number (§9-3).
 */
function currentLine(): number {
  if (mode === "view") return shown && scroller ? viewer.topLine(scroller) : 0;
  return view ? editorTopLine(view) : 0;
}

/** Return focus to the body of the current mode. View mode needs focus in order to receive arrow keys. */
function focusCurrent(): void {
  if (mode === "view") scroller?.focus({ preventScroll: true });
  else view?.focus();
}

/**
 * Reposition the given line at the top of the screen. It means the same thing in
 * both view mode and edit mode — positions are exchanged through a single
 * mechanism, the line number (§9-3). Focus is not moved. For operations that
 * re-lay out the text column (font size, reloading user CSS), we want to restore
 * only the place being read, wherever focus currently is — including inside the
 * find input.
 */
function restoreLine(line: number): void {
  if (mode === "view") {
    // View mode uses `content-visibility: auto`, so off-screen heights are
    // estimates and a single scroll does not land. Re-scrolling is owned by
    // settle in viewer.ts.
    if (scroller && shown) viewer.scrollToLine(scroller, line);
  } else if (view) {
    scrollEditorToLine(view, line);
  }
}

/**
 * Put the given line at the top of the screen and return focus to the body of
 * the current mode. Used on the paths that close a tool and return to reading,
 * such as jumping from the outline or from find.
 */
function jumpToLine(line: number): void {
  restoreLine(line);
  focusCurrent();
}

/**
 * The heading list (§9-2, implementation order 5 of §14). Toggled with `Mod+Shift+O`.
 *
 * It works in edit mode too. "Finding" is not something you only do while
 * reading; navigating to the place you want to fix is the same action. Because
 * the handler lives on window (see keydown below) it does not fight with
 * CodeMirror's keymap, and `Mod+Shift+O` is not in CodeMirror's defaults so
 * there is nothing to take away either. Having the same key mean the same thing
 * in both modes means less to remember (§4, second priority). The jump target
 * can be treated identically in both modes too, once it goes through a line
 * number.
 *
 * The list is built from the authoritative document text (`text` in this file).
 * In edit mode the text just typed is not yet reflected in the rendering, so
 * looking at the already-rendered DOM would produce a stale list.
 */
let outline: typeof import("./outline") | null = null;

async function toggleOutline(): Promise<void> {
  const ui = (outline ??= await import("./outline"));
  // outline.css arrives late via the dynamic import. Push the user CSS back behind it.
  raiseUserCss();
  if (ui.isOpen()) {
    ui.close();
    return;
  }
  ui.open({
    headings: viewer.listHeadings(text),
    current: currentLine(),
    jump: jumpToLine,
    restore: focusCurrent,
  });
}

/**
 * Search within the document (§9-2, implementation order 6 of §14). Opened with `Mod+F`.
 *
 * It is the counterpart to the heading list. The list finds by chapter, find
 * finds by word, and both address the owner's own pain (§2).
 *
 * Like the heading list, the same key means the same thing in edit mode too (§4,
 * second priority). `Mod+F` is not in CodeMirror's default keymap (we do not
 * include `@codemirror/search`), so receiving it on window causes no conflict.
 * The reason for not including it is that it would add one more appearance and
 * one more set of interactions — the same mechanism, searching the text and
 * jumping by line number, covers both modes.
 *
 * What is searched is the authoritative document text (`text` in this file). In
 * edit mode the text just typed is not yet reflected in the rendering, and in
 * view mode off-screen blocks are not laid out yet (EAGER in viewer.ts). Looking
 * at the side that is caught up in neither of those situations is the same
 * decision as the heading list taking headings from the tokens.
 */
let find: typeof import("./find") | null = null;

/**
 * Jump to a match and show it. Focus stays in the find input — being able to
 * press `Enter` repeatedly to advance through matches is a requirement
 * (`jumpToLine` returns focus to the body, so it is not used here).
 */
function showMatch(query: string, at: FindMatch): void {
  if (mode === "view") {
    if (scroller && shown && find) find.showInView(scroller, query);
  } else if (view && cm) {
    // In edit mode, indicate the match with CodeMirror's selection. The editor
    // does not keep off-screen lines in the DOM, so the view-mode highlight (CSS
    // Custom Highlight API) does not hold up as-is. A selection does not touch
    // the document text either, and an existing mechanism is enough.
    view.dispatch({
      selection: { anchor: at.index, head: at.index + query.length },
      // A match is a point, not a line, so placing it in the middle shows more context than the top edge would.
      effects: cm.EditorView.scrollIntoView(at.index, { y: "center" }),
    });
  }
}

async function toggleFind(): Promise<void> {
  const ui = (find ??= await import("./find"));
  // find.css also arrives late (same reason as toggleOutline).
  raiseUserCss();
  // `Mod+F` while open does not close it; it returns to a state where you can
  // retype. That is what browsers do, so there is nothing more to remember (§4,
  // second priority).
  if (ui.isOpen()) {
    ui.refocus();
    return;
  }
  ui.open({
    text,
    from: currentLine(),
    show: showMatch,
    clear: ui.clearInView,
    restore: focusCurrent,
  });
}

// ------------------------------------------------------- the key list (F1)

/**
 * The key list (`F1`). gera has no permanent UI other than the document text
 * (§9), so there is no menu and no toolbar, and not one clue on screen about how
 * to operate it. The users are the owner and a friend, two people (§3), and the
 * friend can do nothing at all on first launch.
 *
 * Why `F1`. It is the accepted spelling for help on both Windows and Linux, and
 * a spelling already in the fingers means nothing new to remember (§4, second
 * priority). `?` cannot be used because it collides with typing text in edit
 * mode. It carries no modifier, so it collides with none of the `Mod+…` bindings
 * gera already uses.
 *
 * It works in both view and edit mode. The handler is on window (see keydown
 * below), so it does not fight with CodeMirror's keymap. `F1` is not in
 * CodeMirror's defaults either.
 *
 * The contents live in a separate chunk via dynamic import (the same shape as
 * the heading list and find). On a launch that only starts up and reads, it is
 * never loaded (§4, first priority).
 */
let keys: typeof import("./keys") | null = null;

async function toggleKeys(): Promise<void> {
  const ui = (keys ??= await import("./keys"));
  // keys.css also arrives late. Push the user CSS back behind it (same reason as toggleOutline).
  raiseUserCss();
  if (ui.isOpen()) {
    ui.close();
    return;
  }
  ui.open({ restore: focusCurrent });
}

/**
 * Show an unobtrusive key list in the edit-mode container, but only while the
 * document is empty (§9-6).
 *
 * Launching with no arguments lands in edit mode on a blank screen. There is
 * nothing to display at that moment, so putting a list here takes nothing away
 * from the screen. And the friend's first launch is most likely exactly this
 * state (§3). It is not permanent UI (§9) — it appears only while the document
 * is empty, and disappears as soon as anything is typed.
 *
 * This is called on every keystroke (`refreshStatus`). If it has not been loaded
 * yet, do nothing — firing a dynamic import here would mean loading running
 * while the user is typing. The only place that shows it for the first time is
 * the startup code (`showEmptyHint`); after that this only toggles it.
 */
function refreshEmptyHint(): void {
  if (!keys || !view) return;
  if (text) keys.hideHint();
  else keys.showHint(view.scrollDOM);
  // The list is on screen only in edit mode. It lives inside `.cm-scroller`, so
  // in view mode the whole container is hidden (the hidden attribute on `#app`).
  refreshTipVisibility(!text && mode === "edit");
}

/** Once at startup. Loaded and shown when we land in edit mode with an empty document. */
async function showEmptyHint(): Promise<void> {
  if (text || !view) return;
  const ui = (keys ??= await import("./keys"));
  raiseUserCss();
  // Do not show it if something was typed while we were waiting. A document that is no longer empty does not need the list.
  if (text || !view) return;
  ui.showHint(view.scrollDOM);
  refreshTipVisibility(mode === "edit");
}

// --------------------------------------------------------------- font size

/**
 * The scale of the text column (§9-4).
 *
 * We touch only the scale (`--font-scale`) and never the base
 * (`--font-size-view` / `--font-size-edit`). The base is where user CSS decides
 * things (§9-4, "kind → user CSS"). Cramming both into a single `font-size`
 * would make `Mod 0` an operation that erases the base the user chose. As long
 * as the two are separate, `Mod 0` returns to "the size the user chose", not to
 * gera's default.
 *
 * The steps match browser zoom levels (80/90/100/110/125/150…). Nothing
 * conceptually new has to be learned at a granularity the user already has in
 * the fingers (§4, second priority). The neighborhood of 100% is in 10% steps
 * because anything finer makes a single press feel like nothing changed, leading
 * to repeated presses, and anything coarser makes "a bit bigger" impossible. It
 * gets coarser further out because at the large end a 10% difference is large in
 * absolute terms.
 *
 * The clamp of 67%–200% corresponds to 11px–34px against the default of 17px.
 * Smaller than that and Japanese kanji collapse into unreadable blobs; larger
 * and the 35em line length (viewer.css) no longer fits on screen, which breaks
 * the premise of the text column, which is to preserve line length.
 */
const SCALES = [0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
/** The position of 1x. Where `Mod 0` returns to, and also the default when an unreadable setting is found. */
const UNIT = SCALES.indexOf(1);
const SCALE_KEY = "gera:font-scale";

/**
 * Read the remembered scale. This is a per-user display setting rather than
 * document content, so it lives in localStorage and not in the stash (the Rust
 * side).
 *
 * Treat being unreadable or corrupt as an ordinary occurrence. In a private
 * window the reference itself throws, and the contents are something the user
 * can edit. Do not bring down startup over something as minor as font size. We
 * snap to the nearest step rather than using the stored value itself so that
 * changing the steps later does not invalidate what was remembered.
 */
function loadScaleIndex(): number {
  let saved: number;
  try {
    saved = Number(localStorage.getItem(SCALE_KEY));
  } catch {
    return UNIT;
  }
  if (!Number.isFinite(saved) || saved <= 0) return UNIT;
  let best = UNIT;
  for (let i = 0; i < SCALES.length; i++) {
    if (Math.abs(SCALES[i]! - saved) < Math.abs(SCALES[best]! - saved)) best = i;
  }
  return best;
}

let scaleIndex = loadScaleIndex();

function applyFontScale(): void {
  document.documentElement.style.setProperty("--font-scale", String(SCALES[scaleIndex] ?? 1));
}

/**
 * Move the scale by one step (`step` of 0 returns to 1x).
 *
 * The moment it changes, the text column is re-laid out and the place being read
 * shifts up or down. Pull it back with the same mechanism as switching modes —
 * through a line number (§9-3). No permanent indicator is added (§9). Instead,
 * since there is no other clue, it is shown once in the banner.
 */
function changeFontScale(step: number): void {
  const next = step === 0 ? UNIT : Math.min(SCALES.length - 1, Math.max(0, scaleIndex + step));
  if (next === scaleIndex) return;
  scaleIndex = next;
  const line = currentLine();
  applyFontScale();
  restoreLine(line);
  try {
    localStorage.setItem(SCALE_KEY, String(SCALES[scaleIndex]));
  } catch {
    // Even if it cannot be remembered, it is in effect for this launch. The user's action succeeded, so stay silent.
  }
  notify(`文字の大きさ ${Math.round((SCALES[scaleIndex] ?? 1) * 100)}%`);
}

// --------------------------------------------------------------- user CSS

/**
 * Inject the CSS the user wrote (§9-4, implementation order 7 of §14).
 *
 * We do not build a settings screen (§9-4; the friend can write CSS). The
 * location is hard-coded on the Rust side, and there is no way from here to
 * specify where to read from (`readUserCss` in host.ts). On most launches the
 * file does not exist, so its absence is not treated as a failure.
 *
 * The injection point is the end of `<head>` because among rules of equal
 * specificity, the one written later wins. gera's own CSS (style.css /
 * viewer.css / katex) is statically imported and is all in `<head>` before this
 * code runs. So a plain `append` lets the user override with straightforward
 * writing such as `:root { --font-serif: … }` — forcing `!important` would
 * demand extra knowledge from whoever is writing it.
 */
let userStyle: HTMLStyleElement | null = null;

function applyUserCss(css: string | null): void {
  if (css === null) {
    // When reloading after the file has been deleted, the previous injection has to go too.
    userStyle?.remove();
    userStyle = null;
    return;
  }
  if (!userStyle) {
    userStyle = document.createElement("style");
    userStyle.id = "gera-user-css";
  }
  // Treat it as nothing but a string. CSS cannot run JS (CSP's default-src
  // 'self' stops scripts, and external references such as `content: url(…)` are
  // blocked by img-src), so inspecting the contents here would not prevent
  // anything. If the syntax is broken, only that rule is dropped — the CSS
  // parser skips broken rules and moves on.
  userStyle.textContent = css;
  document.head.append(userStyle);
}

/**
 * Move the user CSS back to the end of `<head>`.
 *
 * This is needed because some CSS is loaded late. The heading list, find, and
 * edit mode are dynamic imports, so the CSS inside them enters `<head>` after
 * the user CSS. Left alone, the user could not override rules such as
 * `.gera-outline-item` (with equal specificity, later wins). Pushing it back
 * immediately after loading preserves the order.
 */
function raiseUserCss(): void {
  if (userStyle) document.head.append(userStyle);
}

/**
 * The load at startup. Fired without waiting.
 *
 * Startup speed is the first priority (§4). Inserting an `await` here would
 * delay the first paint by that one round trip. Firing it at module evaluation
 * time and letting it run in parallel with `initial_path` and the file read
 * makes the wait effectively zero.
 *
 * Even so, it takes effect before we draw (there is exactly one `await` for it
 * inside the startup code). Applying it after drawing would lay out the text
 * column twice, which costs more.
 */
const userCssAtStart: Promise<void> = (async () => {
  try {
    applyUserCss((await readUserCss()).css);
  } catch (e: unknown) {
    // Do not stay silent about being unable to read it (permissions, etc.). But
    // do not stop startup either — having the document become unreadable over
    // something as minor as an appearance setting is the worse outcome.
    console.error("[gera] 利用者 CSS を読めなかった", e);
    notify(`利用者 CSS を読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }
})();

/**
 * Reload the user CSS (`Mod+,`).
 *
 * This is essential to how the owner works — the intent is to have Claude Code
 * write the CSS and iterate on it (§9-4), and restarting gera after every edit
 * would make that round trip unworkable.
 *
 * We do not follow changes automatically via file watching. Following external
 * modifications is the subject of §9-6 and is not settled yet. Jumping ahead
 * here would implicitly settle something that should be decided.
 *
 * Re-laying out the text column shifts the place being read up or down, so pull
 * it back with the same mechanism as a font size change — through a line number
 * (§9-3).
 */
async function reloadUserCss(): Promise<void> {
  const { path, css } = await readUserCss();
  const line = currentLine();
  applyUserCss(css);
  restoreLine(line);
  // Report both outcomes in the banner. When the screen does not change, the
  // user needs to be able to distinguish "it was applied and happened to look
  // the same" from "there was no file and nothing happened". We print the
  // location itself because, with no settings screen, there is nowhere else to
  // convey where the file should go.
  notify(css === null ? `利用者 CSS がありません: ${path}` : `利用者 CSS を読み直しました: ${path}`);
}

// ------------------------------------------------ external modifications

/**
 * Following external modifications (§9-6, implementation order 9 of §14).
 *
 * The rule is "always announce, and let the person decide whether to reload".
 * There is no branching on whether there are unsaved changes. Having the text
 * silently swapped out while you are reading is itself a loss, and on top of
 * that you cannot tell that it was swapped. gera is also a writer, so reloading
 * on its own turns this into two writers fighting over one file. Following the
 * same convention as browsers — announce, and leave the reload to `Mod+R` —
 * means nothing more to remember either.
 *
 * We check only when the window gains focus, and immediately before a save.
 *
 * - The moment the user edits in Claude Code and comes back to gera is exactly
 *   that moment. It is natural and misses little
 * - We keep no continuously running machinery. We only just fixed a bug that
 *   kept painting at 60fps while idle (§5-10), and adding a polling loop here
 *   would be poor form
 * - File watching (the `notify` crate, etc.) adds a dependency and a resident
 *   thread. What it buys is only "noticing a change while holding focus", and
 *   that situation is rare. Moreover, we always check immediately before a save,
 *   so the misses that actually do harm (a silent overwrite) are caught there
 *
 * We use the DOM `focus` event rather than subscribing to Tauri window events.
 * That avoids adding a permission (`capabilities/default.json`), and since the
 * webview's document also gains focus when the window does, this picks up the
 * moment we need.
 */
window.addEventListener("focus", () => {
  void checkFileChanged();
});

async function checkFileChanged(): Promise<void> {
  // Do nothing when there is nothing to compare against (untitled, restored from the stash).
  // Stay silent when it has already been announced — appearing on every focus until a reload is noisy.
  if (!currentPath || !baseDigest || externalChanged) return;
  let latest: string;
  try {
    latest = await fileDigest(currentPath);
  } catch (e: unknown) {
    // Deleted, or permissions changed, is a different thing from "was modified".
    // Do not show a banner — this is not a response to a user action, so text
    // would appear without the user touching anything. They will find out if
    // they try to save.
    console.error("[gera] 外部の変更を確かめられなかった", e);
    return;
  }
  if (latest === baseDigest) return;
  externalChanged = true;
  notify(
    "このファイルは外部で書き換えられました。Mod+R で読み直します。" +
      (dirty ? "\n未保存の変更は失われます。" : ""),
  );
}

/**
 * The window during which a second `Mod+R` is accepted (§9-6).
 *
 * This is the mechanism that keeps unsaved changes from being discarded
 * silently. We do not build a confirmation dialog (§9), so instead the first
 * press shows a banner announcing it and the second press carries it out. The
 * window is 5 seconds, the same as the banner, in order to keep the warning on
 * screen and the accepting state in agreement — if the banner is gone while the
 * acceptance remains, a `Mod+R` pressed on a screen showing nothing would
 * discard the document.
 *
 * The reasoning that led to not making `Mod+S` a double press does not apply
 * here. Some people press `Ctrl+S` twice out of habit, but `Mod+R` is not a
 * spelling people hammer.
 */
let reloadArmedUntil = 0;

/**
 * Reload the file (`Mod+R`). This replaces the entire document text with the file's content.
 *
 * We do not do block-level replacement. There are three reasons.
 *
 * 1. Going block by block creates a choice about what gets compared with what,
 *    and it becomes natural to write an implementation that compares "the file
 *    as last read" with "the new file". That is merging, and it changes what
 *    `Mod+R` means
 * 2. gera has no diff view. Mixing things together with no way to show which
 *    changes are yours and which are theirs leaves the user unable to check the
 *    result
 * 3. The moment such machinery exists, the question "which blocks are mine?"
 *    arises, and the user has more to remember (§4, second priority)
 *
 * So your own edits are discarded. We pay the cost of re-laying out the whole
 * document (measured at 0.4 seconds, plus a flicker) — because this is an
 * operation that was pressed explicitly.
 *
 * The place being read is preserved by line number (the same mechanism as §9-3).
 * If the rewrite is large enough to shift lines the landing shifts too, but that
 * is far better than jumping to the top.
 */
async function reloadFile(): Promise<void> {
  if (!currentPath) {
    notify("読み直す元のファイルがありません");
    return;
  }
  if (dirty && Date.now() >= reloadArmedUntil) {
    reloadArmedUntil = Date.now() + 5000;
    notify(
      "未保存の変更があります。\n" +
        "もう一度 Mod+R を押すと、ファイルの内容で全体を置き換えます（変更は失われます）。\n" +
        "残したいときは Mod+Shift+S で別名に保存してください。",
    );
    return;
  }
  reloadArmedUntil = 0;

  const line = currentLine();
  const loaded = await readFile(currentPath);
  text = loaded.text;
  baseDigest = loaded.digest;
  externalChanged = false;
  dirty = false;
  refreshStatus();
  if (view) {
    const editor = await import("./editor");
    editor.replaceDoc(view, loaded.text);
    // replaceDoc calls onChange synchronously, so clear dirty afterwards (same as openFile).
    dirty = false;
    refreshStatus();
  }
  // Do not move away from the mode we are in. A reload is not an operation that changes location.
  if (mode === "view") enterView(line);
  else if (view) scrollEditorToLine(view, line);
  notify("ファイルを読み直しました");
}

/**
 * The handler for I/O and mode switching lives on window, not in CodeMirror's keymap.
 *
 * View mode has no CodeMirror — more than that, on a launch that ends in view
 * mode only, it is never even loaded. There is no choice but to receive both
 * directions in one place. `Mod-` is Cmd on macOS and Ctrl on Linux and Windows
 * (§5).
 *
 * What is received here is I/O and mode switching only. Undo and Backspace are
 * left to CodeMirror's default keymap (so that the document text cannot change
 * from a screen that is supposed to be read-only).
 */
window.addEventListener("keydown", (e) => {
  // The key list (`F1`) is the only binding with no modifier, so it is received
  // before the gate below. Do not leave it open alongside another tool — one
  // visible overlay is enough.
  if (e.key === "F1" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    outline?.close();
    find?.close();
    run("キー操作の一覧", toggleKeys);
    return;
  }

  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
  const key = e.key.toLowerCase();

  // If another operation happens while the heading list is open, that list has
  // served its purpose (`Mod+Shift+O` itself is the one exception, since it is
  // the toggle).
  if (outline?.isOpen() && !(key === "o" && e.shiftKey)) outline.close();
  // Find is treated the same way. `Mod+F` itself is the one exception (if open, it returns to the input).
  if (find?.isOpen() && key !== "f") find.close();
  // If another operation happens while the key list is open, that list has served its purpose (`F1` was handled above).
  if (keys?.isOpen()) keys.close();

  // Jump to a heading (§9-2). The spelling matches VS Code's "Go to Symbol in
  // File" — an operation already in the fingers means nothing new to remember (§4).
  if (key === "o" && e.shiftKey) {
    e.preventDefault();
    run("見出しの一覧", toggleOutline);
    return;
  }

  // Search within the document (§9-2). preventDefault is required — passing it
  // to the webview lets the browser's built-in find take it, and that one cannot
  // find anything off screen because of the incremental rendering.
  if (key === "f") {
    e.preventDefault();
    run("文書内検索", toggleFind);
    return;
  }

  if (key === "e") {
    e.preventDefault();
    run("モードの切り替え", toggleMode);
    return;
  }
  // Reload the file (§9-6). The spelling is the same as a browser's, so there is
  // nothing new to remember (§4, second priority). The webview's built-in reload
  // does not work in release builds, but it does in dev, where it rebuilds the
  // whole app, so we preventDefault.
  if (key === "r") {
    e.preventDefault();
    run("ファイルの読み直し", reloadFile);
    return;
  }
  // Reload the user CSS (§9-4). `Mod+,` is the spelling that opens Settings in
  // many editors (VS Code, Zed), and gera's settings are user.css and nothing
  // else — an operation already in the fingers means nothing new to remember
  // (§4, second priority). `Mod+R` is reserved for reloading the document itself
  // (§9-6). `Mod+Shift+R` is easily confused with a browser's "hard reload".
  // `Mod+Shift+U` is used by ibus and GTK for Unicode input, so it would be
  // taken in edit mode only and the behavior would not match across modes.
  // The spelling is not uniquely determined, so, as with font size, we pick it
  // up from both e.key and e.code.
  if (key === "," || e.code === "Comma") {
    e.preventDefault();
    run("利用者 CSS の読み直し", reloadUserCss);
    return;
  }
  if (key === "o" && !e.shiftKey) {
    e.preventDefault();
    run("ファイルを開く操作", openFile);
    return;
  }
  if (key === "s") {
    e.preventDefault();
    const shift = e.shiftKey;
    run(shift ? "名前を付けて保存" : "保存", () => saveFile(shift));
    return;
  }
  // Font size (§9-4). The spelling is not uniquely determined, so we accept
  // both. `+` requires Shift on many layouts, and then e.key is `+` on some
  // layouts and `;` on others. The numpad produces `+` without Shift, but its
  // e.code differs. We take meaning from e.key and position from e.code, and
  // accept it if either matches. We accept `=` because being able to zoom in
  // without Shift is easier to press, and browsers do the same.
  if (key === "+" || key === "=" || e.code === "NumpadAdd" || e.code === "Equal") {
    e.preventDefault();
    changeFontScale(1);
    return;
  }
  if (key === "-" || key === "_" || e.code === "NumpadSubtract" || e.code === "Minus") {
    e.preventDefault();
    changeFontScale(-1);
    return;
  }
  if (key === "0" || e.code === "Numpad0") {
    e.preventDefault();
    changeFontScale(0);
    return;
  }
  // Copy the whole text at once, for pasting back into a conversation with an AI
  // (§11). Mod-c without Shift is copying the selection, so it is left alone and
  // passed to the webview.
  if (key === "c" && e.shiftKey) {
    e.preventDefault();
    run("クリップボードへの出力", async () => {
      await copyToClipboard(text);
      notify("本文をクリップボードにコピーしました");
    });
  }
});

// ------------------------------------------------------------------- startup

/**
 * Measure whether the linchpin of §5 (indicating the mode by typeface) holds,
 * and log the result.
 *
 * This is a diagnostic for developers and creates nothing the user ever sees.
 * Even so, calling it directly at startup costs a measured 68 ms before the
 * first paint (a document with 2,204 formulas, release build, n=3 at 68/68/69
 * ms). What it does is measure mincho and gothic eight times on a 72px canvas,
 * which forces both typefaces to be loaded and their glyphs shaped on the spot —
 * hence that number.
 *
 * Measure after drawing is finished. The diagnostic's result goes only to the
 * console, so nothing is lost by it arriving late. We fall back to setTimeout
 * for implementations without requestIdleCallback.
 */
function reportFontsWhenIdle(): void {
  const idle = (window as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (idle) idle.call(window, reportFontResolution);
  else window.setTimeout(reportFontResolution, 200);
}
reportFontsWhenIdle();

refreshStatus();
// The remembered scale takes effect before the first paint. Applying it later would lay out the text column twice.
applyFontScale();

/**
 * Decide where we land. The command-line argument comes first, the stash second (§9-5).
 *
 * The file named by the argument is "the one we were told to open now", while
 * the stash is "where we left off last time". When both exist, there is no
 * reading under which the previous session wins.
 *
 * A document with content is shown in view mode. gera is mostly a viewer (§1).
 * This path never loads CodeMirror at all.
 *
 * When empty, we start in edit mode. An empty view mode has nothing to display
 * and no cursor (§9-1), so the screen would be blank with no way to type. All
 * the user can do with an empty document is start writing or open something, and
 * the former is only possible in edit mode.
 */
run("起動", async () => {
  const startup = await initialPath();
  // Make it take effect before we draw. It was fired at module evaluation time,
  // so by the time we get here it is usually already done (userCssAtStart above).
  await userCssAtStart;
  if (startup.path) {
    try {
      const loaded = await readFile(startup.path);
      text = loaded.text;
      currentPath = startup.path;
      baseDigest = loaded.digest;
      refreshStatus();
      enterView(0);
      return;
    } catch (e) {
      // The Rust side confirms the file is readable before handing it over, but
      // the path where it is deleted afterwards remains. Rethrowing here would
      // end without entering any mode, leaving the screen blank. Report the
      // reason and fall through to the same path as when there was no argument.
      notify(`${startup.path} を開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (startup.error) {
    notify(`指定されたファイルを開けませんでした: ${startup.error}`);
  }

  // Failing to open the argument is not a reason to discard the stash. The stash
  // is text that has not been written to a file yet, and putting up an empty
  // document here would let the next stash overwrite and destroy it. Do not err
  // toward the side that has something to lose (the same rule as §9-6).
  const session = await loadSession();
  if (session?.text) {
    currentPath = session.path;
    text = session.text;
    // The stash records a state that has not been written to a file, so dirty is not cleared.
    dirty = true;
    refreshStatus();
    enterView(0);
    return;
  }
  await enterEdit();
  // We started with an empty document. There is nothing on screen, so putting the list here takes nothing away.
  await showEmptyHint();
});
