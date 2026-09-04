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
 *
 * **ダイアログとリンクを開く操作も Rust 側で行う**（第7-4節 (a)(d)）。フロント側の
 * プラグインで開くと、選ばれたパスの登録も URL のスキーム検証もフロントの申告に
 * 頼ることになり、webview が乗っ取られた時点で回避される。ここにあるのは
 * 「開いてくれ」と頼む口だけで、**判断は一つも持っていない。**
 */
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface Session {
  path: string | null;
  text: string;
}

/** Tauri の中で動いているか。ブラウザ単体でも画面を確認できるようにするための判定。 */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const SESSION_KEY = "gera:session";

/**
 * 開くダイアログ。**戻ってきたパスは、その時点で Rust 側の許可済み集合に入っている。**
 * 呼び出し側は登録の面倒を見なくてよい（見る手段も無い。第7-4節 (a)）。
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
 * 起動時にコマンドライン引数で渡されたファイル（第9-5節）。
 *
 * `path` が入っていれば、それは**存在して読めることを Rust 側が確かめ済み**で、
 * 許可済み集合にも入っている——そのまま `readFile` に渡してよい。
 * `error` は「引数はあったが開けなかった」ときの理由である。**両方が空**なら
 * 引数が無かったということで、これまでどおり退避からの復元に進む。
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
 * http / https のリンクを OS の既定ブラウザへ渡す（第7-4節 (d)、第9-1節）。
 *
 * **スキームの検証はここでしない。**Rust 側が http と https だけを通す。
 * こちらで弾いても、webview が乗っ取られれば invoke だけが直接飛んでくる。
 */
export async function openExternal(url: string): Promise<void> {
  if (!inTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await invoke<null>("open_external", { url });
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
 * 利用者 CSS（第9-4節、第14節の実装順序 7）。
 *
 * **パスを渡さない。**`readFile` は「利用者が自ら指し示したパスだけ」を通す
 * 仕組み（第7-4節 (a)）で、`user.css` はその集合に入らない。Rust 側に
 * **引数を取らない専用の口**を置き、置き場の決定はそちらに閉じてある。
 * ここから読み先を指定する手段は無い——**無いことが、この仕組みの要である。**
 *
 * `css` が `null` なのは「ファイルが無かった」ときで、これは失敗ではない。
 * 読めなかったときだけ例外になる。`path` は**どこに置けばよいかを利用者へ
 * 伝えるため**に必ず返る（設定画面を作らないので、他に伝える場所が無い）。
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
