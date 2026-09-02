/*!
 * gera のホスト側。設計 第7節。
 *
 * Rust に持たせるのはファイル入出力・ダイアログ・ウィンドウ状態の保存だけである。
 * 編集の論理はすべてフロント側にあり、ここに機能を足していくと
 * 「覚えるべき概念」が二箇所に散る（第3節）。増やさないために置き場を狭くしてある。
 *
 * フロントとの契約は `src/host.ts` が固定している。引数名（path / contents / session）は
 * そのまま受ける。Tauri は JS 側の camelCase を snake_case に読み替えるが、
 * いずれも単語一つなので変換は恒等である。
 */
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 不可視の自動退避の中身（第11節）。フロントの `Session` と同じ形にしてある。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    path: Option<String>,
    text: String,
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path} を読めなかった: {e}"))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("{path} に書けなかった: {e}"))
}

/// 退避ファイルの置き場。アプリ専用領域に置き、利用者からは見えないところに置く（第11節）。
fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("アプリのデータ置き場が決まらなかった: {e}"))?;
    Ok(dir.join("session.json"))
}

/// 退避の読み出し。
///
/// **失敗しても Err を返さない。**退避が壊れていることと、アプリが起動できないことは
/// 別の話であり、後者を前者に引きずられて起こすのは本末転倒である。
/// 読めない・壊れている場合は「退避が無かった」ものとして扱う。
#[tauri::command]
fn load_session(app: AppHandle) -> Result<Option<Session>, String> {
    let Ok(path) = session_path(&app) else {
        return Ok(None);
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&raw).ok())
}

#[tauri::command]
fn save_session(app: AppHandle, session: Session) -> Result<(), String> {
    let path = session_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{} を作れなかった: {e}", dir.display()))?;
    }
    let raw = serde_json::to_string(&session).map_err(|e| format!("退避を組み立てられなかった: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("退避を書けなかった: {e}"))
}

/// 起動している IME デーモンを `/proc/*/comm` から見て、GTK のモジュール名を決める。
///
/// デスクトップ環境ごとの設定ファイルを読みに行くより、
/// **いま実際に動いているもの**を見るほうが外れない。
#[cfg(target_os = "linux")]
fn running_im_module() -> Option<&'static str> {
    let entries = fs::read_dir("/proc").ok()?;
    let mut found_fcitx = false;
    for entry in entries.flatten() {
        // /proc の下には PID 以外のエントリも並ぶ。comm が読めなければ黙って飛ばす。
        let Ok(comm) = fs::read_to_string(entry.path().join("comm")) else {
            continue;
        };
        match comm.trim() {
            // ibus が居れば即決する。fcitx と併走している場合でも
            // XMODIFIERS を持っているのは通常 ibus 側である。
            "ibus-daemon" => return Some("ibus"),
            "fcitx5" | "fcitx" => found_fcitx = true,
            _ => {}
        }
    }
    found_fcitx.then_some("fcitx")
}

/// Linux で GTK の入力メソッドを明示する。**GTK の初期化前に呼ぶこと。**
///
/// 変換中の未確定文字の下線がずれる現象が実測されており、原因は
/// `GTK_IM_MODULE` が空だったことにある。値を入れれば直る。
///
/// これは WebKitGTK の bug 218148（変換候補窓が画面の隅に出る）とは**別の問題**である。
/// 218148 は WebKitGTK 側の欠陥で、こちらでは直せないため代償として受け入れている
/// （設計 第6節）。ここで直せるのは環境変数側の問題だけである。
///
/// 既に値が入っているときは触らない。利用者が意図して設定した値を、
/// アプリが起動のたびに書き換えてよい理由はない。
#[cfg(target_os = "linux")]
fn setup_ime_env() {
    let already_set = |key: &str| std::env::var(key).is_ok_and(|v| !v.is_empty());

    if already_set("GTK_IM_MODULE") {
        return;
    }
    let Some(module) = running_im_module() else {
        return;
    };
    std::env::set_var("GTK_IM_MODULE", module);
    if !already_set("XMODIFIERS") {
        std::env::set_var("XMODIFIERS", format!("@im={module}"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // tauri::Builder に触れる前に置く。GTK は初期化時に一度だけ環境変数を読むため、
    // Builder を組んだあとでは間に合わない。
    #[cfg(target_os = "linux")]
    setup_ime_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // ウィンドウ位置とサイズの保存はプラグインに任せる。
        // 自前で持つと、保存の契機と復元の順序をこちらで正しく扱う必要が出る。
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            load_session,
            save_session
        ])
        .run(tauri::generate_context!())
        .expect("gera の起動に失敗した");
}
