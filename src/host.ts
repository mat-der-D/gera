/**
 * ホスト（Tauri）との接点。設計 第7節。
 *
 * Rust 側の責務はファイル入出力、ダイアログ、ウィンドウ状態の保存のみである。
 * その呼び出しを **このファイル一箇所に集める**。
 *
 * 抽象化の層は設けない。実装が一つしかない層は、それ自体が概念を一つ増やすからである
 * （第3節「覚えるべき概念が少ないこと」）。乗り換えが必要になったとき、
 * 書き直す対象がここだけだと分かっていれば足りる。
 *
 * ファイル入出力に fs プラグインを使わず Rust コマンドを通すのは、
 * 攻撃面を read_file と write_file の二つに絞るためでもある（第7節の sanitize の項）。
 */
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface Session {
  path: string | null;
  text: string;
}

const FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }];

/** Tauri の中で動いているか。ブラウザ単体でも画面を確認できるようにするための判定。 */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const SESSION_KEY = "gera:session";

export async function pickFileToOpen(): Promise<string | null> {
  if (!inTauri) return null;
  const picked = await openDialog({ multiple: false, directory: false, filters: FILTERS });
  return typeof picked === "string" ? picked : null;
}

export async function pickPathToSave(current: string | null): Promise<string | null> {
  if (!inTauri) return null;
  return (await saveDialog({ defaultPath: current ?? "untitled.md", filters: FILTERS })) ?? null;
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export async function writeFile(path: string, contents: string): Promise<void> {
  await invoke<null>("write_file", { path, contents });
}

/**
 * 不可視の自動退避（第11節）。
 *
 * 「保存」という**概念**を UI に出さないことと、退避の**機構**を持つことは両立する。
 * 3000 字超を編集中に落ちて全部消える経路を、コマンドを増やさずに塞ぐためのもの。
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
 * ウィンドウのタイトル。
 *
 * 第5節が禁じているのは**ウィンドウの中身**に常設 UI を置くことである。
 * タイトルバーは OS 側の領分で、本文の面積を奪わないため、ここは使う。
 */
export async function setWindowTitle(title: string): Promise<void> {
  if (!inTauri) {
    document.title = title;
    return;
  }
  await getCurrentWindow().setTitle(title);
}
