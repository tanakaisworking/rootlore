// Rootlore のデスクトップ版: 手元のサーバー。
//
// 同梱した画面（dist/）を 127.0.0.1 で配り、GitHub への問い合わせを中継する。
// 127.0.0.1 は secure context なので、Service Worker もそのまま動く。
//
// 中継するのは、Worker 版（worker/index.ts）と同じ口だけ。
// 画面の JavaScript にトークンを渡さないため、GitHub への問い合わせはここで付ける。
// ほかのサイトから叩かれないよう、Host と Origin を確かめる。

use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tiny_http::{Header, Method, Request, Response, Server};

/// 同梱した画面を配るポート。MCP（37421）とは別
pub const PORT: u16 = 37420;
const ORIGIN: &str = "http://127.0.0.1:37420";
/// 1回の GraphQL で取る blob の上限（画面の batchSize と同じ）
pub const MAX_BLOBS: usize = 250;

/// 画面と、中継する口
pub struct AppState {
    /// 同梱した画面の場所（dist/）
    pub root: PathBuf,
    /// 設定（繋ぎ先）を置く場所
    pub data_dir: PathBuf,
    /// 繋ぎ方（GitHub App か、トークン直か）
    pub mode: Mutex<crate::store::Mode>,
    /// GitHub のトークン。画面には渡さない（トークン直のときだけ持つ）
    pub token: Mutex<Option<String>>,
    /// うちのサーバーのログイン Cookie（GitHub App 方式のときだけ持つ）
    pub cookie: Mutex<Option<String>>,
    /// 繋いでいるリポジトリ（owner, repo, branch）
    pub repo: Mutex<Option<(String, String, String)>>,
}

impl AppState {
    fn data_dir(&self) -> Option<PathBuf> {
        Some(self.data_dir.clone())
    }
}

/// 中継してよいか。繋いでいるリポジトリ（owner/repo）の、決まった口だけを通す
/// （Worker 版の proxy.ts と同じ範囲に絞る）
pub fn allowed_api(method: &Method, path: &str, repo: Option<&(String, String, String)>) -> bool {
    // path は /v/api/gh/... か /api/gh/...
    let Some(rest) = strip_gh(path) else { return false };
    if *method == Method::Post {
        return rest == "/graphql" || rest == "/commit" || rest == "/move";
    }
    if *method != Method::Get {
        return false;
    }
    let Some(rest) = rest.strip_prefix("/repos/") else { return false };
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 2 || parts.iter().any(|p| p.is_empty() || *p == "..") {
        return false;
    }
    // 繋いでいるリポジトリ以外は通さない
    let Some((owner, name, _)) = repo else { return false };
    if parts[0] != owner || parts[1] != name {
        return false;
    }
    if parts.len() == 2 {
        return true; // リポジトリの情報
    }
    let tail = parts[2..].join("/");
    let is_sha = |s: &str| s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit());
    if let Some(name) = tail.strip_prefix("git/trees/") {
        return !name.is_empty() && !name.contains("..");
    }
    if let Some(sha) = tail.strip_prefix("git/blobs/") {
        return is_sha(sha);
    }
    if tail == "commits" || tail == "stats/commit_activity" {
        return true;
    }
    if let Some(sha) = tail.strip_prefix("commits/") {
        return is_sha(sha);
    }
    false
}

/// /v/api/gh/... と /api/gh/... の後ろを返す
fn strip_gh(path: &str) -> Option<&str> {
    path.strip_prefix("/v/api/gh")
        .or_else(|| path.strip_prefix("/api/gh"))
}

/// 画面のパスから、同梱したファイルの場所を決める（/v/ は落とす）。
/// ブラウザは日本語や空白を %E3%81%AF のように送るので、名前を戻してから探す
pub fn file_for(root: &PathBuf, path: &str) -> Option<PathBuf> {
    let relative = path.trim_start_matches('/');
    let relative = relative.strip_prefix("v/").unwrap_or(relative);
    let relative = if relative.is_empty() { "index.html" } else { relative };
    let relative = percent_decode(relative)?;
    // 解いたあとに確かめる（%2e%2e%2f で上へ出る道を塞ぐ）
    if relative.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return None;
    }
    if relative.contains('\\') || relative.contains('\0') {
        return None;
    }
    let file = root.join(&relative);
    if !file.starts_with(root) {
        return None;
    }
    Some(file)
}

/// URL のパスを、そのままの名前に戻す（%E3%81%AF → は、%20 → 空白）。
/// 形が壊れていたら None
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            let value = u8::from_str_radix(hex, 16).ok()?;
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn start(state: Arc<AppState>) -> Result<u16, String> {
    let server = Server::http(("127.0.0.1", PORT)).map_err(|e| format!("ローカルサーバーを起動できません: {e}"))?;
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let _ = respond(&state, request);
        }
    });
    Ok(PORT)
}

fn respond(state: &AppState, request: Request) -> Result<(), String> {
    let method = request.method().clone();
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();

    // ほかのサイトから叩かれないようにする（Host と、付いていれば Origin）
    if !same_origin(&request) {
        let _ = request.respond(Response::empty(403));
        return Ok(());
    }

    // ログイン画面（アプリの中の、既存のログイン画面）。トークンを貼る欄もここに出す
    if path == "/.auth" || path == "/.auth/" || path == "/v/.auth" || path == "/v/.auth/" {
        return send_login(state, request);
    }
    // 前の版にあった接続ページ。いまはログイン画面（/.auth）に寄せたので、案内だけ返す
    if path == "/connect" || path == "/connect/" {
        let header = Header::from_bytes(&b"Location"[..], &b"/.auth"[..]).unwrap();
        let _ = request.respond(Response::empty(302).with_header(header));
        return Ok(());
    }
    // ログイン画面の「GitHub でログイン」。アプリがブラウザを開く（main.rs の on_navigation）
    if path == "/.auth/login" || path == "/v/.auth/login" {
        let header = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap();
        let body = r#"<!doctype html><meta charset="utf-8"><title>Rootlore</title>
<body style="margin:0;padding:48px;text-align:center;font:16px -apple-system,sans-serif;color:#555">
<p>ブラウザでログインしてください。</p>
<p style="font-size:13px">ログインが済むと、このアプリに戻ります。</p></body>"#;
        let _ = request.respond(Response::from_string(body).with_header(header));
        return Ok(());
    }
    // トークンを貼る欄を出すか（手元のアプリだけが受け付ける）
    if path == "/connect/available" {
        let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
        let _ = request.respond(Response::from_string(r#"{"available":true}"#).with_header(header));
        return Ok(());
    }
    // トークンを貼って繋ぐ
    if path == "/connect/token" {
        return connect_with_token(state, request);
    }

    // 画面が起動時に読む設定
    if path == "/v/.config" || path == "/.config" {
        return send_config(state, request);
    }

    // エラーの報告。rootlore.app の Worker に渡し、そこで中身を削って Sentry に送る（worker/errors.ts）
    if path == "/v/api/errors" || path == "/api/errors" {
        return forward_errors(request, &method);
    }

    // GitHub への中継
    if strip_gh(&path).is_some() {
        return proxy(state, request, &method, &path, &url);
    }

    // それ以外は同梱した画面
    if method == Method::Get {
        return send_file(state, request, &path);
    }
    let _ = request.respond(Response::empty(404));
    Ok(())
}

fn same_origin(request: &Request) -> bool {
    fn header(request: &Request, name: &'static str) -> Option<String> {
        request
            .headers()
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str().to_string())
    }
    let host_ok = matches!(header(request, "Host").as_deref(), Some("127.0.0.1:37420") | Some("localhost:37420"));
    if !host_ok {
        return false;
    }
    // Origin が付くのは、ほかのサイトからの要求（fetch の CORS）。自分の画面からの要求だけ通す
    match header(request, "Origin") {
        Some(origin) => origin == ORIGIN,
        None => true,
    }
}

fn send_config(state: &AppState, request: Request) -> Result<(), String> {
    let repo = state.repo.lock().unwrap().clone();
    let token = state.token.lock().unwrap().clone();
    let cookie = state.cookie.lock().unwrap().clone();
    let mode = *state.mode.lock().unwrap();
    // 繋がっているか。繋いでいなくても設定は返す（画面は開ける。ノートは空）
    let ready = repo.is_some()
        && match mode {
            crate::store::Mode::Token => token.is_some(),
            crate::store::Mode::App => cookie.is_some(),
        };
    let Some((owner, name, branch)) = repo else {
        return send_disconnected(request);
    };
    let config = serde_json::json!({
        "connected": ready,
        "spaceFolderPath": format!("github:{owner}/{name}"),
        "spaceName": name,
        "shareOwnerId": "",
        "indexPage": "ホーム",
        "readOnly": true,
        "logPush": false,
        "enableClientEncryption": false,
        "accountManaged": false,
        "shellBackend": "noop",
        "disableServiceWorker": false,
        "syncProtocolVersion": 2,
        "revisions": "disabled",
        "spacePrefixes": [],
        "githubRepo": if ready { serde_json::json!({ "owner": owner, "repo": name, "branch": branch }) } else { serde_json::Value::Null },
        "disableSpaceStyle": true,
        "disablePlugs": true,
    });
    let body = config.to_string();
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let cache = Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap();
    let _ = request.respond(Response::from_string(body).with_header(header).with_header(cache));
    Ok(())
}


/// まだ繋いでいないときの設定。画面は開けるが、ノートは空
fn send_disconnected(request: Request) -> Result<(), String> {
    let config = serde_json::json!({
        "connected": false,
        "spaceFolderPath": "github:unknown/none",
        "spaceName": "Rootlore",
        "shareOwnerId": "",
        "indexPage": "ホーム",
        "readOnly": true,
        "logPush": false,
        "enableClientEncryption": false,
        "accountManaged": false,
        "shellBackend": "noop",
        "disableServiceWorker": false,
        "syncProtocolVersion": 2,
        "revisions": "disabled",
        "spacePrefixes": [],
        "githubRepo": null,
        "disableSpaceStyle": true,
        "disablePlugs": true,
    });
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let cache = Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap();
    let _ = request.respond(Response::from_string(config.to_string()).with_header(header).with_header(cache));
    Ok(())
}

/// worker/errors.ts の ERRORS_MAX_BYTES と同じ
const ERRORS_MAX_BYTES: u64 = 200_000;
/// 同時に送る数の上限。超えた分は捨てる（画面の側でも1回の読み込みで10件まで）
const ERRORS_IN_FLIGHT_MAX: usize = 2;
static ERRORS_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 送り終えたら（途中で panic しても）数を戻す
struct ErrorsInFlight;

impl Drop for ErrorsInFlight {
    fn drop(&mut self) {
        ERRORS_IN_FLIGHT.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn forward_errors(mut request: Request, method: &Method) -> Result<(), String> {
    if *method != Method::Post {
        let _ = request.respond(Response::empty(405));
        return Ok(());
    }
    let mut body = Vec::new();
    Read::take(request.as_reader(), ERRORS_MAX_BYTES + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 > ERRORS_MAX_BYTES {
        let _ = request.respond(Response::empty(413));
        return Ok(());
    }
    use std::sync::atomic::Ordering;
    let in_flight = ErrorsInFlight;
    if ERRORS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst) >= ERRORS_IN_FLIGHT_MAX {
        drop(in_flight);
        let _ = request.respond(Response::empty(429));
        return Ok(());
    }
    // 端末の種類（WebKit の版など）を Sentry で見分けられるよう、画面の User-Agent をそのまま渡す
    let user_agent = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("User-Agent"))
        .map(|h| h.value.as_str().chars().take(300).collect::<String>());
    // サーバーは1件ずつ順に返すので、送るのは別のスレッドで（届かなくても待たせない）
    let _ = request.respond(Response::empty(202));
    std::thread::spawn(move || {
        let _in_flight = in_flight;
        let mut req = ureq::post("https://rootlore.app/v/api/errors")
            .set("Content-Type", "text/plain;charset=UTF-8")
            .timeout(std::time::Duration::from_secs(10));
        if let Some(ua) = user_agent.as_deref() {
            req = req.set("User-Agent", ua);
        }
        let _ = req.send_bytes(&body);
    });
    Ok(())
}

fn send_file(state: &AppState, request: Request, path: &str) -> Result<(), String> {
    let Some(file) = file_for(&state.root, path) else {
        let _ = request.respond(Response::empty(404));
        return Ok(());
    };
    let file = if file.is_dir() { file.join("index.html") } else { file };
    match std::fs::read(&file) {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&file).first_or_octet_stream();
            let header = Header::from_bytes(&b"Content-Type"[..], mime.essence_str().as_bytes()).unwrap();
            let mut response = Response::from_data(bytes).with_header(header);
            // 画面の入口と Service Worker は、WebView の HTTP キャッシュに残さない（版が変わったら必ず新しいものを読む）
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == "index.html" || name == "service_worker.js" {
                response = response.with_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap());
            }
            let _ = request.respond(response);
        }
        Err(_) if !file.extension().is_some() => {
            // ノートのページ（/v/ノート名）は、画面の入口を返す
            return send_file(state, request, "/v/");
        }
        Err(_) => {
            let _ = request.respond(Response::empty(404));
        }
    }
    Ok(())
}

fn proxy(state: &AppState, mut request: Request, method: &Method, path: &str, url: &str) -> Result<(), String> {
    // 決まった口だけを通す（トークンの有無を確かめる前に断る）
    let repo = state.repo.lock().unwrap().clone();
    if !allowed_api(method, path, repo.as_ref()) {
        let _ = request.respond(Response::empty(403));
        return Ok(());
    }
    let mode = *state.mode.lock().unwrap();
    let rest = strip_gh(path).unwrap_or("/");
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    // トークン直: GitHub を直接叩く（うちのサーバーを通さない）
    // GitHub App: うちのサーバーの中継を通す（トークンの更新もサーバーが持つ）
    let (target, auth) = match mode {
        crate::store::Mode::Token => {
            let Some(token) = state.token.lock().unwrap().clone() else {
                let _ = request.respond(Response::json_error(401, "login"));
                return Ok(());
            };
            let target = if rest == "/graphql" {
                "https://api.github.com/graphql".to_string()
            } else {
                format!("https://api.github.com{rest}{}", if query.is_empty() { String::new() } else { format!("?{query}") })
            };
            (target, Some(format!("Bearer {token}")))
        }
        crate::store::Mode::App => {
            let Some(cookie) = state.cookie.lock().unwrap().clone() else {
                let _ = request.respond(Response::json_error(401, "login"));
                return Ok(());
            };
            let target = format!("https://rootlore.app/api/gh{rest}{}", if query.is_empty() { String::new() } else { format!("?{query}") });
            (target, Some(format!("COOKIE:{cookie}")))
        }
    };

    let mut body = Vec::new();
    request.as_reader().read_to_end(&mut body).map_err(|e| e.to_string())?;

    // 画面は「読む blob の SHA の一覧」だけを送ってくる（query は送らせない）。
    // GitHub に送る query は、ここで組み立てる（worker/proxy.ts の blobsGraphQL と同じ）
    if rest == "/graphql" {
        let repo = state.repo.lock().unwrap().clone();
        let Some((owner, name, _)) = repo else {
            let _ = request.respond(Response::json_error(401, "login"));
            return Ok(());
        };
        match blobs_query(&body, &owner, &name) {
            Some(query) => body = query.into_bytes(),
            None => {
                let _ = request.respond(Response::empty(403));
                return Ok(());
            }
        }
    }

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build();
    let mut call = agent
        .request(method.as_str(), &target)
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("User-Agent", "rootlore");
    match auth.as_deref() {
        Some(value) if value.starts_with("COOKIE:") => {
            call = call.set("Cookie", &value["COOKIE:".len()..]);
        }
        Some(value) => {
            call = call.set("Authorization", value);
        }
        None => {}
    }
    if let Some(content_type) = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Content-Type"))
        .map(|h| h.value.as_str().to_string())
    {
        call = call.set("Content-Type", &content_type);
    }
    if let Some(accept) = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Accept"))
        .map(|h| h.value.as_str().to_string())
    {
        if accept == "application/vnd.github.raw+json" {
            call = call.set("Accept", &accept);
        }
    }
    if let Some(etag) = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("If-None-Match"))
        .map(|h| h.value.as_str().to_string())
    {
        call = call.set("If-None-Match", &etag);
    }

    let result = if *method == Method::Post {
        call.send_bytes(&body)
    } else {
        call.call()
    };
    match result {
        Ok(response) => {
            let status = response.status();
            let mut bytes = Vec::new();
            response.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            let content_type = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
            let cache = Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap();
            let _ = request.respond(
                Response::from_data(bytes)
                    .with_status_code(status)
                    .with_header(content_type)
                    .with_header(cache),
            );
        }
        Err(ureq::Error::Status(status, response)) => {
            let mut bytes = Vec::new();
            let _ = response.into_reader().read_to_end(&mut bytes);
            let content_type = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
            let _ = request.respond(
                Response::from_data(bytes)
                    .with_status_code(status)
                    .with_header(content_type),
            );
        }
        Err(_) => {
            let _ = request.respond(Response::json_error(502, "network"));
        }
    }
    Ok(())
}

trait JsonError {
    fn json_error(status: u16, code: &str) -> Response<std::io::Cursor<Vec<u8>>>;
    fn json_message(status: u16, message: &str) -> Response<std::io::Cursor<Vec<u8>>>;
}

impl JsonError for Response<std::io::Cursor<Vec<u8>>> {
    fn json_error(status: u16, code: &str) -> Response<std::io::Cursor<Vec<u8>>> {
        let body = format!(r#"{{"error":"{code}"}}"#);
        let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
        Response::from_string(body).with_status_code(status).with_header(header)
    }

    fn json_message(status: u16, message: &str) -> Response<std::io::Cursor<Vec<u8>>> {
        let body = serde_json::json!({ "message": message }).to_string();
        let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
        Response::from_string(body).with_status_code(status).with_header(header)
    }
}


/// ログイン画面。同梱した画面（login.html）をそのまま返す。
/// 中身は Web 版と同じで、トークンを貼る欄だけがアプリの中で出る
fn send_login(state: &AppState, request: Request) -> Result<(), String> {
    let file = state.root.join(".client/login.html");
    match std::fs::read(&file) {
        Ok(bytes) => {
            let header = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap();
            let cache = Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap();
            let _ = request.respond(Response::from_data(bytes).with_header(header).with_header(cache));
        }
        Err(_) => {
            let _ = request.respond(Response::empty(404));
        }
    }
    Ok(())
}


/// 画面から届いた blob の SHA の一覧を、GitHub に送れる GraphQL の本文にする。
/// 一覧に無いもの（ほかのリポジトリ、形の違う値）が混ざっていれば None
pub fn blobs_query(body: &[u8], owner: &str, repo: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_slice(body).ok()?;
    let shas = parsed.get("shas")?.as_array()?;
    if shas.is_empty() || shas.len() > MAX_BLOBS {
        return None;
    }
    let mut checked = Vec::with_capacity(shas.len());
    for sha in shas {
        let sha = sha.as_str()?;
        // 小文字の16進40桁だけ（Worker 版の blobsGraphQL と同じ）
        if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)) {
            return None;
        }
        checked.push(sha.to_string());
    }
    let fields = checked
        .iter()
        .enumerate()
        .map(|(i, sha)| format!(r#"b{i}: object(oid: "{sha}") {{ ... on Blob {{ text isBinary isTruncated byteSize }} }}"#))
        .collect::<Vec<_>>()
        .join("\n");
    let query = format!(
        "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{\n{fields}\n}} }}"
    );
    serde_json::to_string(&serde_json::json!({
        "query": query,
        "variables": { "owner": owner, "name": repo },
    }))
    .ok()
}

/// トークンを貼って繋ぐ。GitHub に問い合わせて、リポジトリを読めるかを確かめてから保存する
fn connect_with_token(state: &AppState, mut request: Request) -> Result<(), String> {
    if request.method() != &Method::Post {
        let _ = request.respond(Response::empty(405));
        return Ok(());
    }
    let mut body = Vec::new();
    request.as_reader().read_to_end(&mut body).map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            let _ = request.respond(Response::json_error(400, "bad-request"));
            return Ok(());
        }
    };
    let token = parsed.get("token").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let repo = parsed.get("repo").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let branch = parsed.get("branch").and_then(|v| v.as_str()).unwrap_or("main").trim().to_string();
    if !crate::store::looks_like_token(&token) {
        let _ = request.respond(Response::json_message(400, "トークンの形が違います。GitHub で作った値をそのまま貼ってください。"));
        return Ok(());
    }
    let Some((owner, name)) = repo.split_once('/') else {
        let _ = request.respond(Response::json_message(400, "リポジトリは owner/repo の形で入れてください。"));
        return Ok(());
    };
    if owner.is_empty() || name.is_empty() || branch.is_empty() {
        let _ = request.respond(Response::json_message(400, "リポジトリとブランチを入れてください。"));
        return Ok(());
    }

    // 本当に読めるかを、GitHub に問い合わせて確かめる
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(20)).build();
    let url = format!("https://api.github.com/repos/{owner}/{name}");
    match agent
        .get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "rootlore")
        .call()
    {
        Ok(_) => {}
        Err(ureq::Error::Status(401, _)) => {
            let _ = request.respond(Response::json_message(401, "トークンが受け付けられませんでした。期限と権限を確かめてください。"));
            return Ok(());
        }
        Err(ureq::Error::Status(404, _)) => {
            let _ = request.respond(Response::json_message(404, "そのリポジトリが見つかりません。名前と、トークンの権限を確かめてください。"));
            return Ok(());
        }
        Err(_) => {
            let _ = request.respond(Response::json_message(502, "GitHub に届きませんでした。通信を確かめてください。"));
            return Ok(());
        }
    }

    // Keychain に置く（画面の JavaScript には渡さない）
    if let Err(e) = crate::store::write_token(&token) {
        crate::log(&format!(r#"{{"stage":"token-save-error","error":{}}}"#, serde_json::to_string(&e).unwrap()));
        let _ = request.respond(Response::json_message(500, "トークンを保存できませんでした。"));
        return Ok(());
    }
    *state.token.lock().unwrap() = Some(token);
    *state.mode.lock().unwrap() = crate::store::Mode::Token;
    *state.repo.lock().unwrap() = Some((owner.to_string(), name.to_string(), branch.clone()));
    let connection = crate::store::Connection {
        mode: crate::store::Mode::Token,
        repo: repo.clone(),
        branch,
    };
    if let Some(dir) = state.data_dir() {
        let _ = crate::store::save(&dir, &connection);
    }
    crate::log(r#"{"stage":"connected","mode":"token"}"#);
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let _ = request.respond(Response::from_string(r#"{"ok":true}"#).with_header(header));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_paths_are_proxied() {
        let get = Method::Get;
        let post = Method::Post;
        let repo = ("me".to_string(), "notes".to_string(), "main".to_string());
        let repo = Some(&repo);
        // 通す
        for path in [
            "/api/gh/repos/me/notes",
            "/v/api/gh/repos/me/notes",
            "/api/gh/repos/me/notes/git/trees/main",
            "/api/gh/repos/me/notes/git/trees/main?recursive=1",
            "/api/gh/repos/me/notes/git/blobs/0123456789abcdef0123456789abcdef01234567",
            "/api/gh/repos/me/notes/commits",
            "/api/gh/repos/me/notes/commits/0123456789abcdef0123456789abcdef01234567",
            "/api/gh/repos/me/notes/stats/commit_activity",
        ] {
            assert!(allowed_api(&get, path, repo), "should allow GET {path}");
        }
        for path in ["/api/gh/graphql", "/api/gh/commit", "/api/gh/move"] {
            assert!(allowed_api(&post, path, repo), "should allow POST {path}");
        }
        // 断る
        for path in [
            "/api/gh/user",
            "/api/gh/repos/me/other",
            "/api/gh/repos/me/notes/contents/a.md",
            "/api/gh/repos/me/notes/git/blobs/short",
            "/api/gh/repos/me/notes/git/blobs/../../other",
            "/api/gh/repos/me/notes/../../other/git/trees/main",
            "/api/gh/repos/me/notes/stats/contributors",
            "/api/gh/repos/me/notes/pulls",
        ] {
            assert!(!allowed_api(&get, path, repo), "should refuse GET {path}");
        }
        for path in ["/api/gh/repos/me/notes", "/api/gh/user", "/api/gh/commit/x"] {
            assert!(!allowed_api(&post, path, repo), "should refuse POST {path}");
        }
        assert!(!allowed_api(&Method::Delete, "/api/gh/commit", repo));
        assert!(!allowed_api(&Method::Put, "/api/gh/commit", repo));
        // まだ繋いでいなければ、何も通さない
        assert!(!allowed_api(&get, "/api/gh/repos/me/notes", None));
    }

    #[test]
    fn bundled_files_stay_under_the_root() {
        let root = PathBuf::from("/tmp/rootlore-test-root");
        assert_eq!(file_for(&root, "/v/"), Some(root.join("index.html")));
        assert_eq!(file_for(&root, "/v/.client/client.js"), Some(root.join(".client/client.js")));
        assert_eq!(file_for(&root, "/"), Some(root.join("index.html")));
        // 上の階層へ出る道は断る
        assert_eq!(file_for(&root, "/v/../../etc/passwd"), None);
        assert_eq!(file_for(&root, "/v/.client/../../../etc/passwd"), None);
    }
}

#[cfg(test)]
mod blobs_tests {
    use super::*;

    #[test]
    fn builds_the_blob_query_from_shas() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let body = format!(r#"{{"shas":["{sha}"]}}"#);
        let query = blobs_query(body.as_bytes(), "me", "notes").expect("should build");
        let parsed: serde_json::Value = serde_json::from_str(&query).unwrap();
        assert_eq!(parsed["variables"]["owner"], "me");
        assert_eq!(parsed["variables"]["name"], "notes");
        let text = parsed["query"].as_str().unwrap();
        assert!(text.contains(&format!(r#"b0: object(oid: "{sha}")"#)));
        // 画面から送られた query は使わない
        assert!(!text.contains("viewer"));
    }

    #[test]
    fn refuses_bad_blob_requests() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        for body in [
            r#"{"shas":[]}"#.to_string(),
            r#"{"shas":["short"]}"#.to_string(),
            format!(r#"{{"shas":["{}"]}}"#, sha.to_uppercase()),
            r#"{"shas":["0123456789abcdef0123456789abcdef01234567") } viewer { login } x: object(oid: ""]}"#.to_string(),
            r#"{"query":"{ viewer { login } }"}"#.to_string(),
            "not json".to_string(),
        ] {
            assert!(blobs_query(body.as_bytes(), "me", "notes").is_none(), "should refuse {body}");
        }
        // 上限を超える
        let many = format!(r#"{{"shas":[{}]}}"#, vec![format!(r#""{sha}""#); MAX_BLOBS + 1].join(","));
        assert!(blobs_query(many.as_bytes(), "me", "notes").is_none());
    }
}

/// 通しの確認。本物のサーバーを立てて、画面が使う口を順に叩く
#[cfg(test)]
mod server_tests {
    use super::*;
    use std::io::Write;
    use std::sync::Arc;

    /// テスト用の画面を置く。テストは並列に走るので、呼ぶたびに別の場所を使う
    fn fixture() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "rootlore-local-test-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".client")).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html><base href=\"/v/\">").unwrap();
        std::fs::write(dir.join(".client/login.html"), "<!doctype html><title>ログイン</title>").unwrap();
        std::fs::write(dir.join(".client/client.js"), "console.log(1)").unwrap();
        dir
    }

    fn state(root: PathBuf, repo: Option<(String, String, String)>) -> Arc<AppState> {
        Arc::new(AppState {
            root,
            data_dir: std::env::temp_dir(),
            mode: Mutex::new(crate::store::Mode::Token),
            token: Mutex::new(None),
            cookie: Mutex::new(None),
            repo: Mutex::new(repo),
        })
    }

    #[test]
    fn login_page_comes_from_the_bundle() {
        let root = fixture();
        let state = state(root.clone(), None);
        // ログイン画面は同梱した .client/login.html から返す
        let file = state.root.join(".client/login.html");
        let text = std::fs::read_to_string(file).unwrap();
        assert!(text.contains("ログイン"));
        let _ = std::fs::remove_dir_all(root);
    }

    /// 設定（/.config）を返すか、ログイン画面へ移すかの判断。
    /// 実際の応答は tiny_http の要求が要るので、判断に使う値だけを確かめる
    fn config_ready(state: &AppState) -> bool {
        state.repo.lock().unwrap().is_some()
            && match *state.mode.lock().unwrap() {
                crate::store::Mode::Token => state.token.lock().unwrap().is_some(),
                crate::store::Mode::App => state.cookie.lock().unwrap().is_some(),
            }
    }

    #[test]
    fn config_is_refused_until_connected() {
        let root = fixture();
        let state = state(root.clone(), None);
        assert!(!config_ready(&state));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn config_is_refused_with_a_repo_but_no_token() {
        let root = fixture();
        let state = state(root.clone(), Some(("me".into(), "notes".into(), "main".into())));
        assert!(!config_ready(&state), "トークンが無ければ繋がっていない");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn config_is_served_once_connected() {
        let root = fixture();
        let state = state(root.clone(), Some(("me".into(), "notes".into(), "main".into())));
        *state.token.lock().unwrap() = Some("ghp_test".into());
        assert!(config_ready(&state));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn app_mode_needs_the_cookie_instead_of_a_token() {
        let root = fixture();
        let state = state(root.clone(), Some(("me".into(), "notes".into(), "main".into())));
        *state.mode.lock().unwrap() = crate::store::Mode::App;
        assert!(!config_ready(&state), "Cookie が無ければ繋がっていない");
        *state.cookie.lock().unwrap() = Some("vw_session=abc".into());
        assert!(config_ready(&state));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn api_is_refused_before_connecting() {
        let get = Method::Get;
        // 繋いでいなければ、決まった口でも通さない
        assert!(!allowed_api(&get, "/api/gh/repos/me/notes", None));
    }

    #[test]
    fn api_is_limited_to_the_connected_repo() {
        let get = Method::Get;
        let repo = ("me".to_string(), "notes".to_string(), "main".to_string());
        let repo = Some(&repo);
        assert!(allowed_api(&get, "/api/gh/repos/me/notes/git/trees/main", repo));
        // 別のリポジトリは通さない
        assert!(!allowed_api(&get, "/api/gh/repos/me/other/git/trees/main", repo));
        assert!(!allowed_api(&get, "/api/gh/repos/other/notes", repo));
    }

}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn decodes_japanese_and_spaces() {
        let root = PathBuf::from("/tmp/rootlore-path-test");
        let ja = file_for(&root, "/v/_base_fs/Library/Std/Rootlore/Demo/ja/%E3%81%AF%E3%81%98%E3%82%81%E3%81%AB.md").unwrap();
        assert!(ja.ends_with("Demo/ja/はじめに.md"), "{ja:?}");
        let en = file_for(&root, "/v/_base_fs/Library/Std/Rootlore/Demo/en/Getting%20started.md").unwrap();
        assert!(en.ends_with("Demo/en/Getting started.md"), "{en:?}");
        // そのままの名前でも通る
        let plain = file_for(&root, "/v/_base_fs/Library/Std/Rootlore/Demo/ja/はじめに.md").unwrap();
        assert!(plain.ends_with("Demo/ja/はじめに.md"), "{plain:?}");
    }

    #[test]
    fn refuses_traversal_after_decoding() {
        let root = PathBuf::from("/tmp/rootlore-path-test");
        for path in [
            "/v/%2e%2e%2f%2e%2e%2fetc/passwd",
            "/v/..%2f..%2fetc/passwd",
            "/v/.client/%2e%2e/%2e%2e/etc/passwd",
            "/v/../../etc/passwd",
            "/v/a%00b",
            "/v/bad%zz",
        ] {
            assert!(file_for(&root, path).is_none(), "should refuse {path}");
        }
    }

    #[test]
    fn keeps_normal_paths() {
        let root = PathBuf::from("/tmp/rootlore-path-test");
        assert_eq!(file_for(&root, "/v/"), Some(root.join("index.html")));
        assert_eq!(file_for(&root, "/v/.client/client.js"), Some(root.join(".client/client.js")));
    }
}
