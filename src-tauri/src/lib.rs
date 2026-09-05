/*!
 * The host side of gera. See DESIGN.md §7.
 *
 * Rust owns only file I/O, dialogs, and saving window state. All the editing
 * logic lives on the front end, and piling features in here would scatter the
 * "concepts you have to learn" across two places (§3). The surface is kept
 * narrow so that it does not grow.
 *
 * `src/host.ts` pins down the contract with the front end. Argument names
 * (path / contents / session) are taken as they are. Tauri rewrites camelCase on
 * the JS side into snake_case, but each of these is a single word, so the
 * conversion is the identity.
 *
 * Dialogs are opened here. Using the front end's `@tauri-apps/plugin-dialog`
 * would send the chosen path back by way of the front end, which would make
 * registration into `Allowed` depend on what the front end reports. That way,
 * the moment the webview is taken over, an arbitrary path could be registered
 * and `Allowed` would no longer mean anything (§7-4 (a)). The dialogs were moved
 * to this side so that selecting and registering both stay closed inside Rust.
 */
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// The filter shown in the open and save dialogs. Same order as FILTERS in `src/host.ts`.
const FILTER_NAME: &str = "Markdown";
const FILTER_EXTS: &[&str] = &["md", "markdown", "mdown", "txt"];

/// The set of paths the user pointed at with their own hand (§7-4 (a)).
///
/// Only three routes put anything in it — command line arguments, the open
/// dialog, and the save dialog. In every one of them the path is decided on the
/// Rust side, and there is no entry point for the front end to register one.
/// `read_file` / `write_file` refuse any path that is not in here.
///
/// The set lives only for the duration of one run. Carrying it over to the next
/// run would leave that file writable forever after, which would drain the point
/// of narrowing it down.
#[derive(Default)]
struct Allowed(Mutex<HashSet<PathBuf>>);

impl Allowed {
    /// Insert the normalized form, and return exactly the form that was inserted.
    /// If the string handed to the front end drifts from what is in the set, the
    /// very next `read_file` will reject the path this call just registered.
    fn insert(&self, path: &Path) -> Result<PathBuf, String> {
        let normalized = normalize(path)?;
        // A Mutex is only poisoned when another thread panicked while holding it,
        // and what is kept here is a single HashSet. It cannot be left broken, so
        // just take the inner value.
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

/// Put a path into a form that can be compared. It goes through
/// `fs::canonicalize` in order to close off evasion via `..` and symbolic links
/// (§7-4 (a)). Relative paths also become absolute here.
///
/// It has to handle files that do not exist yet. That is the case right after a
/// new name is typed into the save dialog: at that moment there is no file, so
/// canonicalize fails. So canonicalize only the parent directory and append the
/// name — the parent always exists, so `..` and symbolic links are resolved here
/// and no room for evasion is left.
fn normalize(path: &Path) -> Result<PathBuf, String> {
    if let Ok(resolved) = fs::canonicalize(path) {
        return Ok(resolved);
    }
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(format!("{} を解決できなかった", path.display()));
    };
    // The parent is only the empty string for a relative path directly under the
    // current directory.
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let resolved = fs::canonicalize(parent)
        .map_err(|e| format!("{} を解決できなかった: {e}", parent.display()))?;
    Ok(resolved.join(name))
}

/// The contents of the invisible automatic backup (§11). Shaped the same as
/// `Session` on the front end.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    path: Option<String>,
    text: String,
}

/// A path that is not in the set can be neither read nor written (§7-4 (a)).
///
/// The refusal message says nothing beyond "not allowed". Distinguishing whether
/// the file exists would tell the webview about the presence or absence of files
/// outside the set.
fn require_allowed(allowed: &Allowed, path: &str) -> Result<(), String> {
    if allowed.contains(Path::new(path)) {
        return Ok(());
    }
    Err(format!("{path} は開かれていないため触れない"))
}

/// A digest of the contents (§9-6). Used for one thing only: spotting an
/// external rewrite.
///
/// It looks at the contents, not mtime. mtime moves even when the contents are
/// identical — a git checkout or a re-save from another editor would make us
/// claim "this was rewritten" when not one character changed. A false alarm
/// teaches you not to believe the real one.
///
/// It does not use a cryptographic hash. What is guarded here is the route where
/// the user silently wipes out someone else's change, not a defence against an
/// attacker — anyone who can write the file can write whatever they like without
/// bothering to match a digest. So collision resistance is not needed; it is
/// enough that accidental collisions effectively never happen. That is also the
/// reason not to add a new dependency.
///
/// FNV-1a with the length attached. Different lengths always give different
/// digests, so the only way to actually confuse two contents is a 64-bit
/// collision at the same length.
fn digest(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{}-{hash:016x}", bytes.len())
}

/// The digest of what is on disk right now. Used to compare against the digest
/// taken at load time.
///
/// The computation happens here. Carrying 212KB of text over to the front end and
/// counting it there would fatten one IPC round trip just to obtain a digest.
///
/// If it cannot be read, that is an Err. Circumstances like the file being
/// deleted or its permissions changing are a different matter from "it was
/// rewritten", so the caller is left able to tell them apart.
#[tauri::command]
fn file_digest(allowed: State<'_, Allowed>, path: String) -> Result<String, String> {
    require_allowed(&allowed, &path)?;
    let bytes = fs::read(&path).map_err(|e| format!("{path} を読めなかった: {e}"))?;
    Ok(digest(&bytes))
}

/// The text that was read, and the digest at that moment.
///
/// The digest does not get its own entry point; reading always returns it
/// alongside. A separate entry point would make it possible to be in a state
/// where the file was read but the digest was not taken, and a save from that
/// state has nothing to compare against — that is, it silently overwrites
/// (§9-6). The type makes that state impossible.
#[derive(Debug, Serialize)]
struct FileContents {
    text: String,
    digest: String,
}

#[tauri::command]
fn read_file(allowed: State<'_, Allowed>, path: String) -> Result<FileContents, String> {
    require_allowed(&allowed, &path)?;
    let bytes = fs::read(&path).map_err(|e| format!("{path} を読めなかった: {e}"))?;
    let digest = digest(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| format!("{path} は UTF-8 ではない"))?;
    Ok(FileContents { text, digest })
}

/// The result of a write (§9-6).
///
/// A mismatch is not an Err. Err is the shape that means "the save operation
/// failed", and the front end treats it like any other failure. What happens
/// here is not a failure but a refusal exactly as planned, and what the user is
/// shown differs too (the guidance to the ways out). Rather than making the
/// caller parse strings apart, the type separates them.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Written {
    Saved { digest: String },
    Conflict,
}

/// Writing. If `expect` is given, compare against the contents on disk
/// immediately before writing (§9-6).
///
/// The comparison happens here so that read, compare, and write form one
/// unbroken stretch. Splitting it on the front end into "ask for the digest" and
/// "write" would drop whatever was rewritten in the gap between the two.
///
/// When `expect` is `None`, nothing is compared. This is the path taken by
/// save-as (one of the three ways out in §9-6) — it is the only way out when
/// there is a mismatch, so blocking it here would leave nowhere to escape to.
/// Whether overwriting is acceptable when the same name is chosen again has
/// already been settled by the OS save dialog asking "replace it?".
#[tauri::command]
fn write_file(
    allowed: State<'_, Allowed>,
    path: String,
    contents: String,
    expect: Option<String>,
) -> Result<Written, String> {
    require_allowed(&allowed, &path)?;
    if let Some(expect) = expect {
        // Treat an unreadable file as a mismatch. Silently recreating a file that
        // was deleted, or whose permissions changed, would undo the other party's
        // act of deleting it.
        let current = fs::read(&path).map(|bytes| digest(&bytes)).ok();
        if current.as_deref() != Some(expect.as_str()) {
            return Ok(Written::Conflict);
        }
    }
    fs::write(&path, &contents).map_err(|e| format!("{path} に書けなかった: {e}"))?;
    // Return the digest of what was written. Using it as the baseline for the
    // next save keeps our own write from being mistaken for an external
    // rewrite (§9-6).
    Ok(Written::Saved { digest: digest(contents.as_bytes()) })
}

/// The open dialog. The chosen path is put into the set inside this function
/// before being returned to the front end.
///
/// It is an `async fn` with the body in `spawn_blocking` because
/// `blocking_pick_file` blocks the thread that calls it. An async command can run
/// on the same thread as Tauri's event loop, and blocking there freezes the whole
/// window.
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

    // Cancelling is not a failure.
    let Some(picked) = picked else {
        return Ok(None);
    };
    finish_pick(&handle, &picked)
}

/// The save dialog. `current` is used only for the initial display and is not
/// put into the set. The one thing this mechanism turns on is that no permission
/// is granted on the strength of a string that came from the front end.
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

/// Put the destination the dialog returned into the set, and turn it into the
/// string handed to the front end.
///
/// The string is exactly the registered form. Returning anything other than the
/// result of `normalize` would make the string the front end holds disagree with
/// the contents of the set, and the very next read or write would be rejected.
fn finish_pick(
    app: &AppHandle,
    picked: &tauri_plugin_dialog::FilePath,
) -> Result<Option<String>, String> {
    // The Url variant only occurs for Android's content://; it never arrives on
    // the desktop.
    let path = picked
        .clone()
        .into_path()
        .map_err(|e| format!("選ばれた場所を扱えなかった: {e}"))?;
    let registered = app.state::<Allowed>().insert(&path)?;
    Ok(Some(registered.to_string_lossy().into_owned()))
}

/// The entry point through which the front end comes to fetch the command line
/// arguments given at startup (§9-5).
///
/// Both `path` and `error` are returned. Silently falling back to the backup when
/// the argument is broken would leave the user looking at something other than
/// the file they thought they had opened. Returning only an Err, on the other
/// hand, would take away the front end's route to restoring from the backup.
/// Handing over both lets restoration proceed while still reporting the reason.
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

/// Hand only `http` and `https` to the OS (§7-4 (d)).
///
/// The validation is not placed on the front end. If the webview is taken over,
/// the front-end check is never called and only the `invoke` arrives. Handing
/// `file:` or a custom scheme to the OS would let whatever the default
/// application is be launched.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    // Leave no room for a later stage to reinterpret a URL with control
    // characters or whitespace mixed in after the scheme as something else. Only
    // printable ASCII gets through.
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

/// Where the backup file lives. It goes in the app-private area, somewhere the
/// user does not see (§11).
fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("アプリのデータ置き場が決まらなかった: {e}"))?;
    Ok(dir.join("session.json"))
}

/// Reading the backup.
///
/// A failure does not return an Err. The backup being corrupted and the app being
/// unable to start are separate matters, and letting the former drag the latter
/// along would defeat the purpose. If it cannot be read, or is corrupted, it is
/// treated as though there were no backup.
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

/// Where the user CSS lives (§9-4, and step 7 of the implementation order in
/// §14).
///
/// It takes no arguments. `read_file` is a mechanism that accepts only paths the
/// user pointed at with their own hand (§7-4 (a)), and `user.css` is not in that
/// set. Putting it into the set, though, would mark a path the user never pointed
/// at as allowed. So there is a dedicated entry point, and that entry point reads
/// exactly one hard-coded location — since no path can be passed from the front
/// end, taking over this entry point adds nothing to what can be read.
fn user_css_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("アプリの設定置き場が決まらなかった: {e}"))?;
    Ok(dir.join("user.css"))
}

/// The contents of the user CSS, and where it lives.
///
/// `path` is always returned. Given that there is no settings screen (§9-4),
/// there is no other way to tell the user where to put the file. It is shown in
/// the reload notification.
#[derive(Debug, Serialize)]
struct UserCss {
    path: String,
    css: Option<String>,
}

/// Read the user CSS. Its absence is not a failure.
///
/// On most runs this file does not exist. Making its absence an Err would mean
/// either a banner on every startup, or a front-end test that says "ignore this
/// one failure". "Not there" and "could not be read" are separated by the type
/// (`css: None` versus Err).
#[tauri::command]
fn read_user_css(app: AppHandle) -> Result<UserCss, String> {
    let path = user_css_path(&app)?;
    let display = path.to_string_lossy().into_owned();
    match fs::read_to_string(&path) {
        Ok(css) => Ok(UserCss { path: display, css: Some(css) }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(UserCss { path: display, css: None })
        }
        Err(e) => Err(format!("{display} を読めなかった: {e}")),
    }
}

/// Determine the GTK module name by looking at the running IME daemon through
/// `/proc/*/comm`.
///
/// Looking at what is actually running right now misses less often than going and
/// reading each desktop environment's own configuration file.
#[cfg(target_os = "linux")]
fn running_im_module() -> Option<&'static str> {
    let entries = fs::read_dir("/proc").ok()?;
    let mut found_fcitx = false;
    for entry in entries.flatten() {
        // Entries other than PIDs also sit under /proc. If comm cannot be read,
        // skip it silently.
        let Ok(comm) = fs::read_to_string(entry.path().join("comm")) else {
            continue;
        };
        match comm.trim() {
            // If ibus is present, decide immediately. Even when it runs
            // alongside fcitx, the one holding XMODIFIERS is normally ibus.
            "ibus-daemon" => return Some("ibus"),
            "fcitx5" | "fcitx" => found_fcitx = true,
            _ => {}
        }
    }
    found_fcitx.then_some("fcitx")
}

/// State the GTK input method explicitly on Linux. Call this before GTK is
/// initialised.
///
/// A misaligned underline under uncommitted characters during conversion has been
/// measured, and the cause is that `GTK_IM_MODULE` was empty. Setting a value
/// fixes it.
///
/// This is a separate problem from WebKitGTK bug 218148 (the conversion candidate
/// window appearing in a corner of the screen). 218148 is a defect on the
/// WebKitGTK side that cannot be fixed here, so it is accepted as a cost (see
/// DESIGN.md §6). What can be fixed here is only the environment variable side of
/// the problem.
///
/// If a value is already set, leave it alone. There is no reason for the app to
/// rewrite, on every startup, a value the user deliberately configured.
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

/// Pick the one file to open out of the command line arguments (§9-5).
///
/// Only the first one is looked at. gera has no tabs (§10), so even if two or
/// more are passed there is nowhere to open them. Everything from the second on
/// is silently discarded.
///
/// Anything starting with `-` is skipped. Arguments coming from a Windows file
/// association are bare paths, but a webview implementation (WebKitGTK and the
/// like) may mix in flags meant for itself.
fn file_from_args() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
}

/// Inspect the file passed as an argument and, if it is fine to open, put it
/// into the set.
///
/// No failure stops startup. The argument being broken and gera failing to come
/// up are separate matters, and this is treated the same way as reading the
/// backup (`load_session`). It does not stay silent either — the reason is put on
/// `Startup::error` and handed to the front end.
fn resolve_startup(allowed: &Allowed) -> Startup {
    let Some(arg) = file_from_args() else {
        return Startup::default();
    };
    let path = PathBuf::from(&arg);

    // Say "does not exist", "is a directory", and "cannot be read" separately,
    // before opening. Failing after opening would deliver nothing but a uniform
    // "could not be read" to the front end.
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

    // Only now does it go into the set. Only what has been confirmed readable is
    // allowed.
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
    // Placed before tauri::Builder is touched. GTK reads the environment
    // variables exactly once at initialisation, so after the Builder is assembled
    // it is too late.
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
        // Leave saving the window position and size to the plugin. Doing it
        // ourselves would mean getting the save trigger and the restore ordering
        // right on this side.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_digest,
            pick_file_to_open,
            pick_path_to_save,
            initial_path,
            open_external,
            load_session,
            save_session,
            read_user_css
        ])
        .run(tauri::generate_context!())
        .expect("gera の起動に失敗した");
}
