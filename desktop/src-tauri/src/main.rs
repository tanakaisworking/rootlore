// Rootlore のデスクトップ版: 公開中の Rootlore を窓で開く。
// ログインは、ふだんのブラウザで行い（そこで GitHub にログイン済みなら操作はほぼ要らない）、
// 使い捨ての番号を rootlore:// のリンクでアプリに戻して、アプリの中のログイン状態にする（worker/auth.ts の /.auth/desktop）。
// 番号だけ漏れても使えないよう、PKCE（verifier と challenge）を添える
mod cli_link;
mod direct_write;
mod error_report;
mod guard;
mod local;
mod mcp;
mod menu;
mod store;
mod update;

use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

const BASE: &str = "https://rootlore.app";
/// 同梱した画面を配る、手元のサーバー
const LOCAL_ORIGIN: &str = "http://127.0.0.1:37420";
const HOST: &str = "rootlore.app";
/** ログイン画面へ移る動きが続いても、ブラウザを開くのはこの間に1回だけ */
const REOPEN_AFTER: Duration = Duration::from_secs(120);

/// ブラウザで始めたログイン（合言葉 state、PKCE の verifier、始めた時刻）。戻ってきたリンクの state が同じときだけ受け付ける
#[derive(Default)]
struct PendingLogin(Mutex<Option<(String, String, Instant)>>);

/// 窓に差し込むスクリプト。Service Worker が動くかを確かめて report で知らせる（試作の確認用）
const PROBE: &str = r#"
(() => {
  if (window.top !== window) return;
  const send = (stage, data) => {
    const msg = JSON.stringify({ stage, href: location.href, at: new Date().toISOString(), ...data });
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (invoke) invoke("report", { msg }).catch((e) => console.error("report failed", e));
  };
  send("start", { hasServiceWorker: "serviceWorker" in navigator, secureContext: window.isSecureContext });
  // 画面が真っ白になったときに原因を追えるよう、ページの例外を残す
  // 同じ例外が繰り返し出てもログが膨らまないよう、記録は 20 件まで
  let errorsLeft = 20;
  const sendError = (stage, data) => { if (errorsLeft-- > 0) send(stage, data); };
  window.addEventListener("error", (e) => sendError("page-error", { message: String(e.message || e.error), source: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : null }));
  window.addEventListener("unhandledrejection", (e) => sendError("page-rejection", { reason: String(e.reason && (e.reason.stack || e.reason)).slice(0, 2000) }));
  window.addEventListener("load", () => {
    setTimeout(async () => {
      const out = { controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller) };
      try {
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          out.registrations = regs.map((r) => ({ scope: r.scope, state: (r.active || r.installing || r.waiting || {}).state }));
        }
      } catch (e) {
        out.error = String(e);
      }
      out.title = document.title;
      out.notes = document.querySelectorAll(".sb-nav-row").length;
      send("after-load", out);
    }, 8000);
    // 同期の様子を15秒ごとに知らせる（Safari 系の窓で Service Worker が止められていないかを見る）
    setInterval(async () => {
      const c = globalThis.client;
      if (!c) return send("sync", { client: false });
      let listed = null;
      try { listed = (await c.space.spacePrimitives.fetchFileList()).length; } catch (e) { listed = "error:" + e; }
      // Safari 系の窓では、Service Worker の裏の同期が途中で打ち切られる。全体の同期が終わっておらず、
      // 30秒進んでいなければ、ページから同期を頼み直す（止まっていれば、これで起こされる）
      const stalled = !c.fullSyncCompleted && c.lastSyncProgressAt && Date.now() - c.lastSyncProgressAt > 30000;
      if (stalled) {
        c.lastSyncProgressAt = Date.now();
        c.postServiceWorkerMessage({ type: "perform-space-sync" }).catch(() => {});
      }
      send("sync", {
        kicked: !!stalled,
        fullSyncCompleted: !!c.fullSyncCompleted,
        syncedPaths: c.syncedPaths ? c.syncedPaths.size : null,
        sinceProgressSec: c.lastSyncProgressAt ? Math.round((Date.now() - c.lastSyncProgressAt) / 1000) : null,
        controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
        listed,
        visible: document.visibilityState,
      });
    }, 15000);
  });
})();
"#;

pub(crate) fn log(msg: &str) {
    // テストは、使っているアプリのログ（~/Library/Logs）に書かない
    if cfg!(test) {
        return;
    }
    let path = format!("{}/Library/Logs/rootlore-desktop.log", std::env::var("HOME").unwrap_or_default());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", msg);
    }
}

#[tauri::command]
fn report(msg: String) {
    guard::run("report", || log(&msg));
}

/// 同梱した CLI を ~/.local/bin/rootlore に張る（cli_link.rs）。失敗してもアプリは止めない
fn link_cli() {
    let (Some(cli), Some(home)) = (cli_link::bundled_cli(), std::env::var_os("HOME")) else {
        return;
    };
    let bin = std::path::PathBuf::from(home).join(".local/bin");
    match cli_link::provision(&cli, &bin) {
        Ok(cli_link::Outcome::Kept) => {}
        Ok(outcome) => log(&format!("cli-link {outcome:?} {}", bin.join("rootlore").display())),
        Err(e) => log(&format!("cli-link-failed {e}")),
    }
}

fn random_state() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// MCP の鍵。一度作ったら mcp.json に残して使い続ける（AI に登録した鍵が、起動し直しても使えるように）
fn mcp_token(app: &tauri::AppHandle) -> String {
    let saved = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("mcp.json")).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.pointer("/headers/Authorization")?.as_str().map(str::to_string))
        .and_then(|h| h.strip_prefix("Bearer ").map(str::to_string))
        .filter(|t| t.len() >= 32 && t.chars().all(|c| c.is_ascii_alphanumeric()));
    saved.unwrap_or_else(|| random_state() + &random_state())
}

/// MCP の鍵と入口を、AI の設定に貼れる形で書き出す（本人だけが読める）
fn write_mcp_config(app: &tauri::AppHandle, token: &str) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("mcp.json");
    let body = serde_json::json!({
        "url": format!("http://127.0.0.1:{}/mcp", mcp::PORT),
        "headers": { "Authorization": format!("Bearer {token}") }
    });
    if std::fs::write(&path, serde_json::to_string_pretty(&body).unwrap()).is_ok() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        log(&format!(r#"{{"stage":"mcp-ready","config":{:?}}}"#, path.display().to_string()));
    }
}

/// ふだんのブラウザで「アプリでログイン」を開く
fn start_browser_login(app: &tauri::AppHandle) {
    let pending = app.state::<PendingLogin>();
    let mut guard = crate::guard::lock(&pending.0);
    if let Some((_, _, at)) = guard.as_ref() {
        if at.elapsed() < REOPEN_AFTER {
            return;
        }
    }
    let state = random_state();
    let verifier = random_state() + &random_state();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let url = format!("{BASE}/.auth/desktop?state={state}&challenge={challenge}");
    *guard = Some((state, verifier, Instant::now()));
    drop(guard);
    log(r#"{"stage":"browser-login"}"#);
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        log(&format!(r#"{{"stage":"browser-login-error","error":{:?}}}"#, e.to_string()));
    }
    // 窓には、ブラウザでログインするよう案内を出す
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        show_status(
            &handle,
            ("ブラウザでログインしてください。", "ログインが済むと、このアプリに戻ります。"),
            ("Sign in in your browser.", "When you finish, you'll come back to this app."),
            false,
        );
    });
}

/// 窓に、いまの状態を1枚の案内で出す（ログインの途中など、画面がまだ無いとき）。言語はメニューと同じ
fn show_status(app: &tauri::AppHandle, ja: (&str, &str), en: (&str, &str), busy: bool) {
    let Some(w) = app.get_webview_window("main") else { return };
    let (title, note) = if menu::language(app) == "ja" { ja } else { en };
    // 待っている間は、止まっていないと分かるように回る印を出す
    let spinner = if busy {
        "<span style=\"display:inline-block;width:18px;height:18px;margin-bottom:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:vw-spin .8s linear infinite\"></span><style>@keyframes vw-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){span{animation:none!important}}</style>"
    } else {
        ""
    };
    let html = format!(
        "<div role=\"status\" style=\"font:16px -apple-system,sans-serif;padding:48px;text-align:center;color:#777\">{spinner}<p>{}</p><p style=\"font-size:13px\">{}</p></div>",
        html_text(title),
        html_text(note)
    );
    let _ = w.eval(&format!(
        "document.title='Rootlore';document.body.innerHTML={};",
        serde_json::to_string(&html).unwrap_or_default()
    ));
}

fn html_text(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// rootlore://auth?code=…&state=… でアプリに戻ってきたとき。
///
/// 番号の引き換えは、ここ（Rust）で行う。窓の中の画面は手元のサーバーのもので、
/// うちのサーバーの Cookie を持てないため。受け取った Cookie はアプリの中に置き、
/// 中継（local.rs の App モード）で使う。画面の JavaScript には渡さない
fn handle_deep_link(app: &tauri::AppHandle, url: &Url) {
    if url.scheme() != "rootlore" || url.host_str() != Some("auth") {
        return;
    }
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let (Some(code), Some(state)) = (query.get("code"), query.get("state")) else { return };
    let pending = app.state::<PendingLogin>();
    let expected = crate::guard::lock(&pending.0).take();
    let verifier = match expected {
        Some((s, verifier, _)) if &s == state => verifier,
        _ => {
            log(r#"{"stage":"deep-link-rejected"}"#);
            return;
        }
    };
    // 番号は英数字だけ（Worker の形）
    if !code.chars().all(|c| c.is_ascii_alphanumeric()) || code.len() > 64 {
        return;
    }
    log(r#"{"stage":"deep-link-ok"}"#);

    // 番号と verifier を、うちのサーバーに送ってログイン状態（Cookie）を受け取る
    let body = serde_json::json!({ "code": code, "verifier": verifier }).to_string();
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build();
    let result = agent
        .post(&format!("{BASE}/.auth/desktop/redeem"))
        .set("Content-Type", "application/json")
        .send_string(&body);
    let cookie = match result {
        Ok(response) => {
            let raw = response_cookie(&response);
            let login = response
                .into_json::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("login").and_then(|l| l.as_str()).map(str::to_string));
            match (login, raw) {
                (Some(login), Some(cookie)) => {
                    log(&format!(r#"{{"stage":"desktop-login","login":{}}}"#, serde_json::to_string(&login).unwrap()));
                    Some(cookie)
                }
                _ => None,
            }
        }
        Err(e) => {
            log(&format!(r#"{{"stage":"desktop-login-error","error":{}}}"#, serde_json::to_string(&e.to_string()).unwrap()));
            None
        }
    };

    // setup で Arc<AppState> として登録している。型が違うと state() は止まる（GitHub で繋いだ直後に落ちていた）
    let state_handle = app.state::<std::sync::Arc<local::AppState>>();
    let Some(cookie) = cookie else {
        show_login_failed(app);
        return;
    };
    *crate::guard::lock(&state_handle.cookie) = Some(cookie.clone());
    // 開き直しても、アプリを更新しても、つなぎ直さなくて済むように残す
    if let Err(e) = store::write_session(&cookie) {
        log(&serde_json::json!({ "stage": "session-save-error", "error": e }).to_string());
    }
    *crate::guard::lock(&state_handle.mode) = store::Mode::App;
    // 繋ぎ先は、うちのサーバーの設定から受け取る（リポジトリとブランチ）
    if let Some((owner, name, branch)) = server_repo(&agent, &cookie) {
        *crate::guard::lock(&state_handle.repo) = Some((owner.clone(), name.clone(), branch.clone()));
        let dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let _ = store::save(
            &dir,
            &store::Connection { mode: store::Mode::App, repo: format!("{owner}/{name}"), branch },
        );
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(format!("{LOCAL_ORIGIN}/v/").parse().unwrap());
        let _ = w.set_focus();
    }
}

/// 応答の Set-Cookie から、セッションの Cookie を取り出す（名前と値だけ）
pub(crate) fn response_cookie(response: &ureq::Response) -> Option<String> {
    for header in response.all("Set-Cookie") {
        let pair = header.split(';').next()?.trim();
        if pair.starts_with("vw_session=") {
            return Some(pair.to_string());
        }
    }
    None
}

/// うちのサーバー（/.config）から、繋ぐリポジトリを受け取る
fn server_repo(agent: &ureq::Agent, cookie: &str) -> Option<(String, String, String)> {
    let config = agent
        .get(&format!("{BASE}/.config"))
        .set("Cookie", cookie)
        .call()
        .ok()?
        .into_json::<serde_json::Value>()
        .ok()?;
    let repo = config.get("githubRepo")?;
    Some((
        repo.get("owner")?.as_str()?.to_string(),
        repo.get("repo")?.as_str()?.to_string(),
        repo.get("branch")?.as_str().unwrap_or("main").to_string(),
    ))
}

fn show_login_failed(app: &tauri::AppHandle) {
    show_status(
        app,
        ("ログインできませんでした。", "アプリを開き直して、もう一度お試しください。"),
        ("Couldn't sign in.", "Reopen the app and try again."),
        false,
    );
}

/// 同梱した画面（dist/）の場所。開発中はリポジトリの dist/ を使う
fn local_root(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("frontend");
        if bundled.join("index.html").exists() {
            return bundled;
        }
    }
    // 開発中（cargo run / tauri dev）は、リポジトリの dist/ をそのまま使う
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist")
}

/// 同梱した画面の版を見分ける印。Service Worker のファイルには、ビルドごとに変わるキャッシュ名が入っている
/// 読めないときは None（印が固定されて、版が変わっても捨てられなくなるのを避ける）
fn frontend_stamp(root: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(root.join("service_worker.js")).ok()?;
    let digest = Sha256::digest(&bytes);
    Some(digest[..8].iter().map(|b| format!("{b:02x}")).collect())
}

/// 同梱した画面が前回の起動と違うときは、古い Service Worker とそのキャッシュを捨ててから読み直す。
/// Service Worker は画面をキャッシュから先に返すので、捨てないと前の版の画面が残り、真っ白になることがある。
/// ノートの写し（IndexedDB）と設定（localStorage）は消さない
fn frontend_reset_script(stamp: &str) -> String {
    format!(
        r#"(() => {{
  if (window.top !== window || (location.hostname !== "127.0.0.1" && location.hostname !== "localhost")) return;
  const stamp = "{stamp}";
  const key = "rootlore-desktop-frontend";
  let saved;
  try {{ saved = localStorage.getItem(key); }} catch {{ return; }}
  if (saved === stamp) return;
  (async () => {{
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    const report = (data) => invoke && invoke("report", {{ msg: JSON.stringify(data) }}).catch(() => {{}});
    // 1つでも消せなければ印を書かない（次の起動でやり直す）
    let failed = [];
    try {{
      const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      const names = window.caches ? await caches.keys() : [];
      const results = await Promise.allSettled([
        ...regs.map((r) => r.unregister()),
        ...names.map((n) => caches.delete(n)),
      ]);
      failed = results.filter((r) => r.status === "rejected").map((r) => String(r.reason));
    }} catch (e) {{
      failed = [String(e)];
    }}
    if (failed.length > 0) {{
      report({{ stage: "frontend-reset-failed", to: stamp, failed }});
      return;
    }}
    try {{ localStorage.setItem(key, stamp); }} catch {{ return; }}
    report({{ stage: "frontend-reset", from: saved, to: stamp }});
    location.reload();
  }})();
}})();"#
    )
}

fn main() {
    guard::install_panic_log();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingLogin::default())
        .manage(mcp::McpState::default())
        .manage(menu::MenuState::default())
        .manage(update::Pending::default())
        .invoke_handler(tauri::generate_handler![report, mcp::mcp_result, menu::set_menu_state, error_report::set_error_reports])
        .on_menu_event(|app, event| {
            guard::run("menu", || menu::handle(app, event.id().as_ref()));
        })
        .setup(|app| {
            guard::run("cli-link", link_cli);
            menu::apply(app.handle(), "en", false).map_err(std::io::Error::other)?;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                // ログインの戻り。通信を含むので、画面のスレッドでは動かさない（OS から呼ばれる所で止まると、アプリごと落ちる）
                for url in event.urls() {
                    let handle = handle.clone();
                    // 承認したらすぐアプリを前に出し、待っている間も動いていると分かるようにする（以前は固まって見えた）
                    if url.scheme() == "rootlore" && url.host_str() == Some("auth") {
                        guard::run("deep-link-status", || {
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.set_focus();
                            }
                            show_status(
                                &handle,
                                ("ログインしています…", "ノートを開く準備をしています。"),
                                ("Signing in…", "Getting your notes ready."),
                                true,
                            );
                        });
                    }
                    guard::spawn("deep-link", move || {
                        if guard::run("deep-link-login", || handle_deep_link(&handle, &url)).is_none() {
                            show_login_failed(&handle);
                        }
                    });
                }
            });
            // 同梱した画面を、手元のサーバー（127.0.0.1）で配る。
            // 画面は同梱なので、うちのサーバーが止まっても開ける（GitHub には直接つなぐ）
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let connection = store::load(&data_dir);
            let token = store::read_token();
            let repo = connection.as_ref().and_then(|c| c.owner_repo());
            let root = local_root(app.handle());
            let reset_script = frontend_stamp(&root).map(|stamp| frontend_reset_script(&stamp)).unwrap_or_default();
            let state = std::sync::Arc::new(local::AppState {
                root,
                data_dir: data_dir.clone(),
                mode: Mutex::new(connection.as_ref().map(|c| c.mode).unwrap_or(store::Mode::Token)),
                token: Mutex::new(token),
                // GitHub App 方式のログインは Keychain から戻す（以前は残さず、開き直すたびに未接続になっていた）
                cookie: Mutex::new(match connection.as_ref().map(|c| c.mode) {
                    Some(store::Mode::App) => store::read_session(),
                    _ => None,
                }),
                repo: Mutex::new(repo.map(|(owner, name)| (owner, name, connection.as_ref().unwrap().branch.clone()))),
            });
            // ディープリンク（ログインの戻り）からも同じ状態を使えるようにする
            app.manage(state.clone());
            let port = local::start(state.clone()).map_err(std::io::Error::other)?;
            // 起動したら、まず画面を出す。繋ぎ方はアカウントのページから選ぶ
            let start = format!("http://127.0.0.1:{port}/v/");
            let nav = app.handle().clone();
            let new_window = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start.parse().unwrap()))
                .title("Rootlore")
                .inner_size(1200.0, 800.0)
                .initialization_script(&reset_script)
                .initialization_script(PROBE)
                .initialization_script(include_str!("mcp.js"))
                // ドラッグは画面（WebKit）に渡す。Tauri の受け取り処理が有効だと、ドラッグを先に取って画面に渡さず、
                // 左のファイル一覧でのドラッグによる移動が効かなかった（wry の wkwebview/drag_drop.rs）。アプリでは使っていない
                .disable_drag_drop_handler()
                // うちのサーバーのログイン画面へ移る動きだけ、ブラウザでのログインに置き換える
                .on_navigation(move |url| {
                    guard::run("navigation", || {
                        // 手元の画面から「GitHub でログイン」を押したとき（/.auth/login）と、
                        // 公開中のサイトのログイン画面に移ろうとしたときだけ、ブラウザでのログインに置き換える
                        let local_login = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
                            && url.path() == "/.auth/login";
                        let remote_login = url.host_str() == Some(HOST)
                            && (url.path() == "/.auth" || url.path() == "/.auth/login");
                        if local_login || remote_login {
                            start_browser_login(&nav);
                            return false;
                        }
                        true
                    })
                    .unwrap_or(true)
                })
                // 新しい窓で開くリンク（target="_blank" や window.open。要望の GitHub の Issue など）は、
                // アプリの中では受け皿がなく何も起きないので、ふだんのブラウザで開く。http と https だけ
                .on_new_window(move |url, _features| {
                    guard::run("new-window", || {
                        if matches!(url.scheme(), "http" | "https") {
                            if let Err(e) = new_window.opener().open_url(url.as_str(), None::<&str>) {
                                log(&format!("open-external-failed {e}"));
                            }
                        }
                    });
                    tauri::webview::NewWindowResponse::Deny
                });
            #[cfg(target_os = "macos")]
            let window = window.hidden_title(true).title_bar_style(tauri::TitleBarStyle::Transparent);
            window.build()?;
            let token = mcp_token(app.handle());
            write_mcp_config(app.handle(), &token);
            mcp::start(app.handle().clone(), token);
            update::check_after_start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Rootlore")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                guard::run("install-on-exit", || update::install_pending(app));
            }
        });
}
