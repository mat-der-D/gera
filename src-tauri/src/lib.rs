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
 *
 * **ダイアログはここで開く。**フロント側の `@tauri-apps/plugin-dialog` を使うと、
 * 選ばれたパスがフロントを経由して戻ってくるため、`Allowed` への登録も
 * フロントからの申告に頼ることになる。それでは webview が乗っ取られた時点で
 * 任意のパスを登録できてしまい、`Allowed` を置いた意味が消える（第7-4節 (a)）。
 * 選択と登録を Rust 側で閉じるために、ダイアログをこちら側へ移してある。
 */
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// 開くダイアログと保存ダイアログで見せる絞り込み。`src/host.ts` の FILTERS と同じ並びである。
const FILTER_NAME: &str = "Markdown";
const FILTER_EXTS: &[&str] = &["md", "markdown", "mdown", "txt"];

/// **利用者が自分の手で指し示したパスの集合**（第7-4節 (a)）。
///
/// 入るのは三つの経路だけである——コマンドライン引数、開くダイアログ、保存ダイアログ。
/// いずれも Rust 側でパスが決まる経路であり、**フロントから登録する口は無い。**
/// `read_file` / `write_file` はここに無いパスを拒む。
///
/// 集合は起動のあいだだけ持つ。次の起動へ持ち越すと、そのファイルが以後ずっと
/// 書き込み可能なままになり、絞った意味が薄れる。
#[derive(Default)]
struct Allowed(Mutex<HashSet<PathBuf>>);

impl Allowed {
    /// 正規化した形で入れ、**入れた形をそのまま返す。**フロントへ渡す文字列と
    /// 集合の中身がずれると、直後の `read_file` が自分で登録したパスに弾かれる。
    fn insert(&self, path: &Path) -> Result<PathBuf, String> {
        let normalized = normalize(path)?;
        // Mutex が毒されるのは他のスレッドが保持中に panic した場合だけで、
        // ここに置いてあるのは HashSet 一つである。壊れようがないので中身を取り出す。
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(normalized.clone());
        Ok(normalized)
    }

    fn contains(&self, path: &Path) -> bool {
        normalize(path).is_ok_and(|normalized| {
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains(&normalized)
        })
    }
}

/// パスを突き合わせられる形に直す。**`..` とシンボリックリンクによる回避を潰すため**に
/// `fs::canonicalize` を通す（第7-4節 (a)）。相対パスもここで絶対パスになる。
///
/// **まだ存在しないファイルも扱えなければならない。**保存ダイアログで新しい名前を
/// 入力した直後がそれで、その時点ではファイルが無いので canonicalize は失敗する。
/// 親ディレクトリだけを canonicalize して名前を継ぎ足す——親は必ず存在するので、
/// `..` とシンボリックリンクはここで解け、回避の余地は残らない。
fn normalize(path: &Path) -> Result<PathBuf, String> {
    if let Ok(resolved) = fs::canonicalize(path) {
        return Ok(resolved);
    }
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(format!("{} を解決できなかった", path.display()));
    };
    // 親が空文字列になるのはカレントディレクトリ直下の相対パスのときだけである。
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let resolved = fs::canonicalize(parent)
        .map_err(|e| format!("{} を解決できなかった: {e}", parent.display()))?;
    Ok(resolved.join(name))
}

/// 不可視の自動退避の中身（第11節）。フロントの `Session` と同じ形にしてある。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    path: Option<String>,
    text: String,
}

/// 集合に無いパスは、読むことも書くこともさせない（第7-4節 (a)）。
///
/// **拒否の文面に「許可されていない」以上のことを書かない。**存在するかどうかを
/// 言い分けると、集合の外にあるファイルの有無を webview に教えることになる。
fn require_allowed(allowed: &Allowed, path: &str) -> Result<(), String> {
    if allowed.contains(Path::new(path)) {
        return Ok(());
    }
    Err(format!("{path} は開かれていないため触れない"))
}

#[tauri::command]
fn read_file(allowed: State<'_, Allowed>, path: String) -> Result<String, String> {
    require_allowed(&allowed, &path)?;
    fs::read_to_string(&path).map_err(|e| format!("{path} を読めなかった: {e}"))
}

#[tauri::command]
fn write_file(allowed: State<'_, Allowed>, path: String, contents: String) -> Result<(), String> {
    require_allowed(&allowed, &path)?;
    fs::write(&path, contents).map_err(|e| format!("{path} に書けなかった: {e}"))
}

/// 開くダイアログ。選ばれたパスを**この中で**集合に入れてからフロントへ返す。
///
/// `async fn` にして中身を `spawn_blocking` に置くのは、`blocking_pick_file` が
/// 呼んだスレッドを止めるからである。非同期コマンドは Tauri のイベントループと
/// 同じスレッドで走ることがあり、そこで止めると窓ごと固まる。
#[tauri::command]
async fn pick_file_to_open(app: AppHandle) -> Result<Option<String>, String> {
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(FILTER_NAME, FILTER_EXTS)
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("ダイアログを開けなかった: {e}"))?;

    // 取り消しは失敗ではない。
    let Some(picked) = picked else {
        return Ok(None);
    };
    finish_pick(&handle, &picked)
}

/// 保存ダイアログ。`current` は初期表示に使うだけで、**集合には入れない。**
/// フロントから来た文字列を根拠に許可を出さない、という一点がこの仕組みの要である。
#[tauri::command]
async fn pick_path_to_save(
    app: AppHandle,
    current: Option<String>,
) -> Result<Option<String>, String> {
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file().add_filter(FILTER_NAME, FILTER_EXTS);
        match current.as_deref().map(Path::new) {
            Some(path) => {
                if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
                    builder = builder.set_directory(dir);
                }
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    builder = builder.set_file_name(name);
                }
            }
            None => builder = builder.set_file_name("untitled.md"),
        }
        builder.blocking_save_file()
    })
    .await
    .map_err(|e| format!("ダイアログを開けなかった: {e}"))?;

    let Some(picked) = picked else {
        return Ok(None);
    };
    finish_pick(&handle, &picked)
}

/// ダイアログが返した行き先を集合へ入れ、フロントへ渡す文字列にする。
///
/// **登録した形をそのまま文字列にする。**`normalize` を通した結果を返さないと、
/// フロントが持つ文字列と集合の中身が食い違い、直後の読み書きが弾かれる。
fn finish_pick(
    app: &AppHandle,
    picked: &tauri_plugin_dialog::FilePath,
) -> Result<Option<String>, String> {
    // Url の変種になるのは Android の content:// だけで、デスクトップでは来ない。
    let path = picked
        .clone()
        .into_path()
        .map_err(|e| format!("選ばれた場所を扱えなかった: {e}"))?;
    let registered = app.state::<Allowed>().insert(&path)?;
    Ok(Some(registered.to_string_lossy().into_owned()))
}

/// 起動時のコマンドライン引数（第9-5節）を、フロントが取りに来るための口。
///
/// **`path` と `error` を両方返す。**引数が壊れていたときに黙って退避へ落ちると、
/// 利用者は「開いたつもりのファイルではないもの」を見ることになる。かといって
/// Err だけを返すと、フロント側が退避からの復元へ進む道を失う。両方渡して、
/// 復元は進めつつ理由は伝える形にする。
#[derive(Debug, Default, Serialize)]
struct Startup {
    path: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn initial_path(startup: State<'_, Startup>) -> Startup {
    Startup {
        path: startup.path.clone(),
        error: startup.error.clone(),
    }
}

/// `http` と `https` だけを OS へ渡す（第7-4節 (d)）。
///
/// **検証をフロントに置かない。**webview が乗っ取られれば、フロント側の検査は
/// 呼ばれずに `invoke` だけが飛んでくる。`file:` や独自スキームを OS に渡すと、
/// 既定のアプリケーションが何であれ起動できてしまう。
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    // スキームの後ろに制御文字や空白が混ざったものを、後段が別のものとして
    // 読み直す余地を残さない。ASCII の可視文字だけを通す。
    if url.is_empty() || url.bytes().any(|b| !(0x21..=0x7e).contains(&b)) {
        return Err(format!("この URL は渡せない: {url}"));
    }
    let scheme = url.split_once("://").map(|(s, _)| s.to_ascii_lowercase());
    if !matches!(scheme.as_deref(), Some("http") | Some("https")) {
        return Err(format!("http と https 以外は開かない: {url}"));
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("{url} を開けなかった: {e}"))
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

/// コマンドライン引数から、開くべきファイルを一つ選ぶ（第9-5節）。
///
/// **見るのは最初の一つだけである。**gera はタブを持たない（第10節）ので、
/// 二つ以上渡されても開ける先が無い。二つ目以降は黙って捨てる。
///
/// `-` で始まるものは飛ばす。Windows のファイル関連付けから来る引数は素のパスだが、
/// webview の実装（WebKitGTK など）が自分向けの旗を混ぜて渡してくる場合がある。
fn file_from_args() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
}

/// 引数で渡されたファイルを検分し、開いてよければ集合に入れる。
///
/// **どの失敗でも起動は止めない。**引数が壊れていることと、gera が立ち上がらない
/// ことは別の話であり、退避の読み出し（`load_session`）と同じ扱いにする。
/// ただし黙りもしない——理由を `Startup::error` に載せてフロントへ渡す。
fn resolve_startup(allowed: &Allowed) -> Startup {
    let Some(arg) = file_from_args() else {
        return Startup::default();
    };
    let path = PathBuf::from(&arg);

    // 存在しない・ディレクトリ・読めない、を**開く前に**分けて言う。
    // 開いてから失敗させると、フロントには一様な「読めなかった」しか届かない。
    let error = match fs::metadata(&path) {
        Err(e) => Some(format!("{arg} を開けません: {e}")),
        Ok(meta) if meta.is_dir() => Some(format!("{arg} はディレクトリです")),
        Ok(_) => match fs::File::open(&path) {
            Err(e) => Some(format!("{arg} を読めません: {e}")),
            Ok(_) => None,
        },
    };
    if let Some(error) = error {
        return Startup { path: None, error: Some(error) };
    }

    // ここで初めて集合に入れる。**読めることを確かめたものだけを許可する。**
    match allowed.insert(&path) {
        Ok(registered) => Startup {
            path: Some(registered.to_string_lossy().into_owned()),
            error: None,
        },
        Err(e) => Startup { path: None, error: Some(e) },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // tauri::Builder に触れる前に置く。GTK は初期化時に一度だけ環境変数を読むため、
    // Builder を組んだあとでは間に合わない。
    #[cfg(target_os = "linux")]
    setup_ime_env();

    let allowed = Allowed::default();
    let startup = resolve_startup(&allowed);

    tauri::Builder::default()
        .manage(allowed)
        .manage(startup)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // ウィンドウ位置とサイズの保存はプラグインに任せる。
        // 自前で持つと、保存の契機と復元の順序をこちらで正しく扱う必要が出る。
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            pick_file_to_open,
            pick_path_to_save,
            initial_path,
            open_external,
            load_session,
            save_session
        ])
        .run(tauri::generate_context!())
        .expect("gera の起動に失敗した");
}
