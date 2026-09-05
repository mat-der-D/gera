/**
 * The seam with the host (Tauri). See DESIGN.md §7.
 *
 * The Rust side is responsible only for file I/O, dialogs, and saving window state.
 * Every call to it is gathered into this one file.
 *
 * No abstraction layer is introduced. A layer with only one implementation is itself
 * one more concept to learn (§3, 「覚えるべき概念が少ないこと」 — "few concepts to
 * remember"). If a switch of host is ever needed, it is enough to know that this is
 * the only place to rewrite.
 *
 * File I/O goes through Rust commands rather than the fs plugin partly to narrow the
 * attack surface down to the two of read_file and write_file (the sanitize item
 * in §7).
 *
 * Opening dialogs and links is done on the Rust side too (§7-4 (a)(d)). Opening them
 * through a front-end plugin would make both the registration of the chosen path and
 * the scheme validation of the URL depend on what the front end declares, and both
 * would be bypassed the moment the webview is taken over. What is here is only the
 * mouth that asks "please open this"; it holds no decision at all.
 */
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface Session {
  path: string | null;
  text: string;
}

/** Whether we are running inside Tauri. This test exists so the screen can also be
 * checked in a plain browser. */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const SESSION_KEY = "gera:session";

/**
 * The open dialog. A path that comes back is, by that point, already in the Rust
 * side's allowed set. The caller does not have to take care of registering it (nor
 * does it have any means of seeing it; §7-4 (a)).
 */
export async function pickFileToOpen(): Promise<string | null> {
  if (!inTauri) return null;
  return (await invoke<string | null>("pick_file_to_open")) ?? null;
}

export async function pickPathToSave(current: string | null): Promise<string | null> {
  if (!inTauri) return null;
  return (await invoke<string | null>("pick_path_to_save", { current })) ?? null;
}

/**
 * The file passed on the command line at launch (§9-5).
 *
 * If `path` is filled in, the Rust side has already confirmed that it exists and can
 * be read, and it is in the allowed set — it can be handed straight to `readFile`.
 * `error` is the reason for "there was an argument but it could not be opened". If
 * both are empty, there was no argument, and we proceed as before to restoring from
 * the auto-saved session.
 */
export interface Startup {
  path: string | null;
  error: string | null;
}

export async function initialPath(): Promise<Startup> {
  if (!inTauri) return { path: null, error: null };
  return invoke<Startup>("initial_path");
}

/**
 * Hands an http / https link to the OS's default browser (§7-4 (d), §9-1).
 *
 * The scheme is not validated here. The Rust side lets only http and https through.
 * Rejecting on this side would achieve nothing: once the webview is taken over, the
 * invoke alone arrives directly.
 */
export async function openExternal(url: string): Promise<void> {
  if (!inTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await invoke<null>("open_external", { url });
}

/**
 * The text that was read, together with its digest at that moment (§9-6).
 *
 * The digest is not a separate call: reading always returns it alongside. A separate
 * call would make it possible to reach a state of "read, but failed to take the
 * digest", and a save from there has nothing to compare against — that is, it would
 * silently overwrite. The content is a string decided solely by the Rust side; this
 * side only ever looks at whether two of them are equal.
 */
export interface FileContents {
  text: string;
  digest: string;
}

export async function readFile(path: string): Promise<FileContents> {
  return invoke<FileContents>("read_file", { path });
}

/**
 * The digest of what is on disk right now (§9-6). Called when focus returns, and in
 * any other situation where we want to check.
 *
 * The computation happens on the Rust side. Carrying the text over IPC and counting
 * it here would fatten a round trip merely to obtain a digest. If it cannot be read,
 * this throws (deleted, or permissions changed).
 */
export async function fileDigest(path: string): Promise<string> {
  return invoke<string>("file_digest", { path });
}

/**
 * The result of a write (§9-6).
 *
 * A mismatch is not an exception. An exception is the shape that means "the save
 * operation failed", and on the calling side it becomes the same banner as any other
 * failure. What happens here is not a failure but a refusal exactly as designed, and
 * what the user is shown differs too (guidance toward a way out).
 */
export type Written = { kind: "saved"; digest: string } | { kind: "conflict" };

/**
 * Writes. If `expect` is given, the Rust side compares against the contents on disk
 * immediately before writing, and on a mismatch returns `conflict` without writing
 * (§9-6).
 *
 * Passing `null` for `expect` skips the comparison. That is the path save-as takes —
 * it is the only way out when there is a mismatch, so closing it would leave nowhere
 * to escape to.
 */
export async function writeFile(
  path: string,
  contents: string,
  expect: string | null,
): Promise<Written> {
  return invoke<Written>("write_file", { path, contents, expect });
}

/**
 * The invisible automatic session backup (§11).
 *
 * Keeping the concept of "saving" out of the UI and having a mechanism for backup are
 * not in conflict. This exists to close the path where a crash while editing over
 * 3000 characters loses everything — without adding a command.
 */
export async function loadSession(): Promise<Session | null> {
  if (!inTauri) {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  }
  return invoke<Session | null>("load_session");
}

export async function saveSession(session: Session): Promise<void> {
  if (!inTauri) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return;
  }
  await invoke<null>("save_session", { session });
}

export async function copyToClipboard(text: string): Promise<void> {
  if (!inTauri) {
    await navigator.clipboard.writeText(text);
    return;
  }
  await writeText(text);
}

/**
 * User CSS (§9-4; implementation step 7 in §14).
 *
 * No path is passed. `readFile` is a mechanism that lets through only paths the user
 * pointed at themselves (§7-4 (a)), and `user.css` is not in that set. A dedicated
 * call that takes no arguments is placed on the Rust side, and the decision of where
 * the file lives is closed up over there. There is no means from here of specifying
 * what to read — and that absence is the crux of the mechanism.
 *
 * `css` being `null` means "the file was not there", which is not a failure. Only an
 * unreadable file throws. `path` always comes back so the user can be told where to
 * put the file (there is no settings screen, so there is nowhere else to tell them).
 */
export interface UserCss {
  path: string;
  css: string | null;
}

export async function readUserCss(): Promise<UserCss> {
  if (!inTauri) return { path: "", css: null };
  return invoke<UserCss>("read_user_css");
}

/**
 * The window title.
 *
 * What §5 forbids is placing permanent UI inside the window's contents. The title bar
 * is the OS's territory and takes no area away from the text, so this one is used.
 */
export async function setWindowTitle(title: string): Promise<void> {
  if (!inTauri) {
    document.title = title;
    return;
  }
  await getCurrentWindow().setTitle(title);
}
