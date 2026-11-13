// Rootlore の CLI（rootlore）。GitHub が正本の Vault を、探す前に取り込み（変わったノートだけ）、手元の写しで探す・読む・書く。
// ログインは、ふだんのブラウザで行い（Worker の /.auth/desktop）、使い捨ての番号を手元の受け口で受け取る。
// GitHub の鍵は持たず、Worker の中継（接続した1つのリポジトリだけ）を通して読み書きする。
// 取り込んだノートは、読むだけの写し（キャッシュの置き場所）に置く。書くときは、写しを直さずに write・append で送る。
// 送るときは読んだときの版を添え、GitHub で先に変わっていれば3方向でまとめる。同じ所がぶつかったら、
// GitHub のノートはそのままにして、印付きのまとめを「ノート名.conflicted-日時.md」に残す（何も消さない）。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{IsTerminal, Read};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};

const DEFAULT_BASE: &str = "https://rootlore.app";
const LOGIN_NEEDED: &str = "ログインが必要です。rootlore login を実行してください。";
const BLOB_BATCH: usize = 100;
/** 最後の取り込みからこの秒数のあいだは、GitHub に問い合わせずに前回の写しで答える（続けて探すときを速くする） */
const FRESH_SECS: u64 = 30;

type Result<T> = std::result::Result<T, String>;

// --- 置き場所 ---

fn base_url() -> String {
    std::env::var("ROOTLORE_URL").unwrap_or_else(|_| DEFAULT_BASE.into()).trim_end_matches('/').into()
}

/// 本人だけが開けるフォルダ（ログイン情報と、非公開の Vault の写しを置くため）
fn private_dir(dir: PathBuf) -> Result<PathBuf> {
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(dir)
}

fn config_dir() -> Result<PathBuf> {
    private_dir(dirs::config_dir().ok_or("設定の置き場所が分かりません")?.join("rootlore"))
}

fn cache_root() -> Result<PathBuf> {
    private_dir(dirs::cache_dir().ok_or("キャッシュの置き場所が分かりません")?.join("rootlore"))
}

/// URL のパスの1区切りとして使えるようにする（ブランチ名の / などを %2F に）
fn path_segment(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("random");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 本人だけが読めるように書く（途中で切れても壊れないよう、毎回ちがう名前に書いてから置き換える）
fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", random_hex(6)));
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::io::Write::write_all(&mut f, data).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let tmp = path.with_file_name(format!(".{}.vw-tmp-{}", path.file_name().unwrap().to_string_lossy(), random_hex(6)));
    fs::write(&tmp, data).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// 同時に動いた CLI（人の操作と AI など）が、取り込みやトークンの更新を重ねないための鍵。
/// OS のファイルロックなので、CLI が落ちても自動で外れる（長い取り込みの最中に奪われることもない）
struct Lock(#[allow(dead_code)] fs::File);

impl Lock {
    fn take(path: PathBuf, wait: Duration) -> Result<Lock> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let deadline = SystemTime::now() + wait;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Lock(file)),
                Err(std::fs::TryLockError::WouldBlock) if SystemTime::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                Err(std::fs::TryLockError::WouldBlock) => {
                    return Err(format!("ほかの rootlore が終わるのを待ちきれませんでした: {}", path.display()))
                }
                Err(std::fs::TryLockError::Error(e)) => return Err(format!("{}: {e}", path.display())),
            }
        }
    }
}

// --- ログイン情報と通信 ---

fn session_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("session"))
}

fn read_session() -> Option<String> {
    let text = fs::read_to_string(session_path().ok()?).ok()?;
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn session_cookie(resp: &ureq::Response) -> Option<String> {
    resp.all("set-cookie").iter().find_map(|h| {
        let value = h.strip_prefix("vw_session=")?.split(';').next()?.to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("rootlore-cli/", env!("CARGO_PKG_VERSION")))
        .build()
}

struct Api {
    base: String,
    agent: ureq::Agent,
    cookie: String,
}

impl Api {
    fn new() -> Result<Api> {
        let cookie = read_session().ok_or(LOGIN_NEEDED)?;
        Ok(Api { base: base_url(), agent: agent(), cookie })
    }

    fn once(&self, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>) -> std::result::Result<ureq::Response, ureq::Error> {
        let mut req = self
            .agent
            .request(method, &format!("{}{}", self.base, path))
            .set("Cookie", &format!("vw_session={}", self.cookie));
        for (k, v) in headers {
            req = req.set(k, v);
        }
        match body {
            Some(b) => req.set("Content-Type", "application/json").send_string(b),
            None => req.call(),
        }
    }

    /// トークンが切れていたら1回だけ更新してやり直す
    fn call(&mut self, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<ureq::Response> {
        self.call_allowing(method, path, headers, body, None)
    }

    /// allow の状態（書き込みの 409 など）は、失敗にせず返事として返す
    fn call_allowing(&mut self, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>, allow: Option<u16>) -> Result<ureq::Response> {
        for attempt in 0..2 {
            match self.once(method, path, headers, body) {
                Ok(resp) => return Ok(resp),
                Err(ureq::Error::Status(code, resp)) if Some(code) == allow => return Ok(resp),
                Err(ureq::Error::Status(401, resp)) => {
                    let text = resp.into_string().unwrap_or_default();
                    if attempt == 0 && text.contains("\"refresh\"") {
                        self.refresh()?;
                        continue;
                    }
                    return Err(LOGIN_NEEDED.into());
                }
                Err(ureq::Error::Status(code, _)) => return Err(format!("{path}: HTTP {code}")),
                Err(e) => return Err(format!("Rootlore に届きませんでした（{e}）")),
            }
        }
        Err(LOGIN_NEEDED.into())
    }

    /// refresh token は1回しか使えないので、ほかの CLI と重ならないようにする
    fn refresh(&mut self) -> Result<()> {
        let _lock = Lock::take(config_dir()?.join("refresh.lock"), Duration::from_secs(60))?;
        if let Some(saved) = read_session() {
            if saved != self.cookie {
                // 待っている間に、ほかの CLI が更新を済ませていた
                self.cookie = saved;
                return Ok(());
            }
        }
        let resp = match self.once("POST", "/.auth/refresh", &[], Some("")) {
            Ok(resp) => resp,
            Err(ureq::Error::Status(_, _)) => return Err(LOGIN_NEEDED.into()),
            Err(e) => return Err(format!("Rootlore に届きませんでした（{e}）")),
        };
        let cookie = session_cookie(&resp).ok_or(LOGIN_NEEDED)?;
        write_private(&session_path()?, cookie.as_bytes())?;
        self.cookie = cookie;
        Ok(())
    }

    fn json(&mut self, method: &str, path: &str, body: Option<&str>) -> Result<Value> {
        let resp = self.call(method, path, &[], body)?;
        resp.into_json::<Value>().map_err(|e| format!("{path}: {e}"))
    }
}

// --- ログイン ---

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).status();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url).status();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).status();
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

fn login() -> Result<()> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("手元の受け口を開けません: {e}"))?;
    let port = server.server_addr().to_ip().ok_or("手元の受け口を開けません")?.port();
    let state = random_hex(16);
    // PKCE: 番号が漏れても、この CLI が持つ verifier がなければ引き換えられない
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).expect("random");
    let verifier = URL_SAFE_NO_PAD.encode(secret);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let url = format!("{}/.auth/desktop?state={state}&port={port}&challenge={challenge}", base_url());
    eprintln!("ブラウザでログインしてください。開かないときは、次の URL を開いてください。\n{url}");
    open_browser(&url);

    let deadline = SystemTime::now() + Duration::from_secs(300);
    let code = loop {
        let left = deadline.duration_since(SystemTime::now()).map_err(|_| "5分以内にログインが済みませんでした")?;
        let Some(request) = server.recv_timeout(left).map_err(|e| e.to_string())? else {
            return Err("5分以内にログインが済みませんでした".into());
        };
        let url = request.url().to_string();
        let query = url.strip_prefix("/callback?").unwrap_or("");
        let ok = query_param(query, "state").as_deref() == Some(state.as_str());
        let code = query_param(query, "code").filter(|c| c.chars().all(|ch| ch.is_ascii_alphanumeric()));
        let page = if ok && code.is_some() {
            "ログインしました。このタブは閉じてかまいません。"
        } else {
            "このリンクは使えません。ターミナルで rootlore login をやり直してください。"
        };
        let html = format!("<!doctype html><meta charset=utf-8><title>Rootlore</title><p style=\"font:16px sans-serif;padding:40px\">{page}</p>");
        let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap();
        let _ = request.respond(tiny_http::Response::from_string(html).with_header(header));
        if ok {
            if let Some(code) = code {
                break code;
            }
        }
    };

    // 番号と verifier は URL に載せず、本文で送る（記録に残さない）
    let resp = agent()
        .post(&format!("{}/.auth/desktop/redeem", base_url()))
        .send_json(json!({ "code": code, "verifier": verifier }))
        .map_err(|e| format!("ログインを受け取れませんでした（{e}）"))?;
    let cookie = session_cookie(&resp).ok_or("ログインを受け取れませんでした")?;
    {
        // ほかの CLI のトークン更新と、ログイン情報の保存を重ねない
        let _lock = Lock::take(config_dir()?.join("refresh.lock"), Duration::from_secs(60))?;
        write_private(&session_path()?, cookie.as_bytes())?;
    }
    let mut api = Api::new()?;
    let me = api.json("GET", "/.auth/me", None)?;
    println!("{} でログインしました。", me["login"].as_str().unwrap_or("?"));
    Ok(())
}

// --- 取り込み ---

#[derive(Serialize, Deserialize, Clone)]
struct Repo {
    owner: String,
    repo: String,
    branch: String,
}

#[derive(Serialize, Deserialize, Default)]
struct State {
    repo: Option<Repo>,
    etag: Option<String>,
    /// ノートの場所 -> blob の SHA
    files: BTreeMap<String, String>,
    synced_at: Option<u64>,
}

struct Store {
    dir: PathBuf,
    state: State,
}

impl Store {
    fn notes_dir(&self) -> PathBuf {
        self.dir.join("notes")
    }
    fn state_path(&self) -> PathBuf {
        self.dir.join("state.json")
    }
}

/// 写しは、接続先のリポジトリとブランチごとに分ける（Worker の設定が変わったら、別の写しになる）
fn store_name(repo: &Repo) -> String {
    let clean = |s: &str| s.replace(['/', '\\', ':'], "_");
    format!("{}__{}__{}", clean(&repo.owner), clean(&repo.repo), clean(&repo.branch))
}

fn open_named(name: &str) -> Result<Store> {
    let dir = cache_root()?.join(name);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let state = fs::read_to_string(dir.join("state.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    Ok(Store { dir, state })
}

/// 最後に取り込んだ写し。まだなければエラー
fn open_store() -> Result<Store> {
    let pointer = cache_root()?.join("current");
    match fs::read_to_string(&pointer) {
        Ok(name) if !name.trim().is_empty() => open_named(name.trim()),
        _ => Err("まだ取り込んでいません。rootlore pull を実行してください。".into()),
    }
}

/// rootlore が読まない場所（隠しフォルダ、同梱の標準ライブラリ）と、写しの外を指しうる名前
/// （.. や、Windows のドライブ・区切りの \ と :）を弾く
fn is_note(path: &str) -> bool {
    path.ends_with(".md")
        && !path.starts_with("Library/Std/")
        && path.split('/').all(|s| !s.is_empty() && !s.starts_with('.') && !s.contains(['\\', ':']))
        && Path::new(path).components().all(|c| matches!(c, Component::Normal(_)))
}

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
}

/// GitHub から取り込む。一覧が変わっていなければ1回の問い合わせで終わる
fn pull(api: &mut Api) -> Result<Store> {
    let _lock = Lock::take(cache_root()?.join("pull.lock"), Duration::from_secs(600))?;
    // 接続先は毎回確かめる（Worker でリポジトリやブランチを変えたら、その写しに切り替える）
    let config = api.json("GET", "/.config", None)?;
    let repo: Repo = serde_json::from_value(config["githubRepo"].clone()).map_err(|_| LOGIN_NEEDED)?; // 開くリポジトリをまだ選んでいない（ログインで選ぶ）
    let name = store_name(&repo);
    let mut store = open_named(&name)?;
    store.state.repo = Some(repo.clone());
    write_atomic(&cache_root()?.join("current"), name.as_bytes())?;
    let base = format!("/api/gh/repos/{}/{}", repo.owner, repo.repo);
    // 写しが欠けていたら（手で消された、など）、「変わっていない」と言われても取り直す
    let notes = store.notes_dir();
    let complete = store.state.files.keys().all(|p| notes.join(p).is_file());
    let etag = store.state.etag.clone().filter(|_| complete);
    let mut headers = vec![];
    if let Some(etag) = etag.as_deref() {
        headers.push(("If-None-Match", etag));
    }
    let resp = api.call("GET", &format!("{base}/git/trees/{}?recursive=1", path_segment(&repo.branch)), &headers, None)?;
    if resp.status() == 304 {
        store.state.synced_at = Some(now_secs());
        save_state(&store)?;
        return Ok(store);
    }
    let new_etag = resp.header("etag").map(str::to_string);
    let tree: Value = resp.into_json().map_err(|e| e.to_string())?;
    if tree["truncated"].as_bool() == Some(true) {
        // 欠けた一覧で「消えた」と判断すると、正しいノートを消してしまう。何も変えずに止める
        return Err("GitHub のファイル一覧が大きすぎて一部が欠けたので、取り込みを止めました".into());
    }
    let entries: Vec<TreeEntry> = serde_json::from_value(tree["tree"].clone()).map_err(|e| e.to_string())?;
    let mut wanted: BTreeMap<String, String> = BTreeMap::new();
    // 大文字小文字だけが違うノートは、Mac や Windows では同じファイルになり、片方で上書きされる。2つ目以降は取り込まない
    let mut sorted: Vec<TreeEntry> = entries.into_iter().filter(|e| e.kind == "blob" && is_note(&e.path)).collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut seen = CaseSeen::default();
    for e in sorted {
        if seen.take(&e.path) {
            wanted.insert(e.path, e.sha);
        } else {
            eprintln!("注意: 大文字小文字だけが違うノートやフォルダと重なるので、取り込みませんでした: {}", e.path);
        }
    }

    let removed: Vec<String> = store.state.files.keys().filter(|p| !wanted.contains_key(*p)).cloned().collect();
    // 中身が同じノートは1回だけ取る
    let mut by_sha: HashMap<String, Vec<String>> = HashMap::new();
    for (path, sha) in &wanted {
        let same = store.state.files.get(path) == Some(sha) && notes.join(path).exists();
        if !same {
            by_sha.entry(sha.clone()).or_default().push(path.clone());
        }
    }
    let shas: Vec<String> = by_sha.keys().cloned().collect();
    let total = shas.len();
    if total > 50 {
        eprintln!("GitHub から {total} 件のノートを取り込みます…");
    }
    // 全部取れるまで、写しには触らない（途中で失敗しても、前回の写しのまま使える）
    let mut fetched: HashMap<String, Vec<u8>> = HashMap::new();
    for chunk in shas.chunks(BLOB_BATCH) {
        let body = json!({ "shas": chunk }).to_string();
        let result = api.json("POST", "/api/gh/graphql", Some(&body))?;
        let blobs = &result["data"]["repository"];
        if blobs.is_null() {
            return Err(format!("GitHub からノートを取れませんでした: {}", result["errors"]));
        }
        for (i, sha) in chunk.iter().enumerate() {
            let blob = &blobs[format!("b{i}")];
            let text = blob["text"].as_str().filter(|_| blob["isTruncated"].as_bool() != Some(true) && blob["isBinary"].as_bool() != Some(true));
            let data: Vec<u8> = match text {
                Some(t) if t.len() as u64 == blob["byteSize"].as_u64().unwrap_or(u64::MAX) => t.as_bytes().to_vec(),
                // 大きいもの、UTF-8 でないものは原本を取る
                _ => blob_bytes(api, &repo, sha)?,
            };
            fetched.insert(sha.clone(), data);
        }
    }
    // 写しを書き換える前に、「変わっていない」の目印と、書き換え・削除するノートの版の記録を捨てておく。
    // 途中で止まっても、次の取り込みでそのノートを必ず取り直す（GitHub が元に戻っても、違う中身が残らない）
    store.state.etag = None;
    for paths in by_sha.values() {
        for path in paths {
            store.state.files.remove(path);
        }
    }
    for path in &removed {
        store.state.files.remove(path);
    }
    save_state(&store)?;
    // 消すものを先に消し、空になったフォルダも片付ける（a.md が a.md/ のフォルダに変わった、などに備える）
    for path in &removed {
        let file = notes.join(path);
        let _ = fs::remove_file(&file);
        let mut dir = file.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if d == notes || fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }
    for (sha, data) in &fetched {
        for path in &by_sha[sha] {
            write_atomic(&notes.join(path), data)?;
        }
    }
    let removed = removed.len();
    store.state.files = wanted;
    store.state.etag = new_etag;
    store.state.synced_at = Some(now_secs());
    save_state(&store)?;
    if total > 0 || removed > 0 {
        eprintln!("取り込みました（更新 {total} 件、削除 {removed} 件）");
    }
    Ok(store)
}

fn api_base(repo: &Repo) -> String {
    format!("/api/gh/repos/{}/{}", repo.owner, repo.repo)
}

/// SHA で指したノートの原本
fn blob_bytes(api: &mut Api, repo: &Repo, sha: &str) -> Result<Vec<u8>> {
    let resp = api.call("GET", &format!("{}/git/blobs/{sha}", api_base(repo)), &[("Accept", "application/vnd.github.raw+json")], None)?;
    let mut buf = vec![];
    resp.into_reader().read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn save_state(store: &Store) -> Result<()> {
    write_atomic(&store.state_path(), serde_json::to_string(&store.state).unwrap().as_bytes())
}

/// 探す・読む前の取り込み。GitHub に届かなければ、前回の写しで続ける
fn fresh_store(no_pull: bool) -> Result<Store> {
    if no_pull {
        return open_store();
    }
    if let Ok(store) = open_store() {
        if store.state.synced_at.is_some_and(|t| now_secs().saturating_sub(t) < FRESH_SECS) {
            return Ok(store);
        }
    }
    let mut api = Api::new()?;
    match pull(&mut api) {
        Ok(store) => Ok(store),
        Err(e) if e == LOGIN_NEEDED => Err(e),
        Err(e) => {
            let store = open_store()?;
            if store.state.synced_at.is_none() {
                return Err(e);
            }
            eprintln!("注意: 最新を取り込めなかったので、前回の写しを使います（{e}）");
            Ok(store)
        }
    }
}

// --- 探す・読む ---

struct Options {
    words: Vec<String>,
    limit: usize,
    prefix: String,
    json: bool,
    no_pull: bool,
    /// 読んだときの版。Some(None) は「まだないノートとして書く」（--base new）
    base: Option<Option<String>>,
    message: Option<String>,
    /// resolve で消す食い違いの写しと、読んだときの版（conflicts で読んだもの）
    copies: Vec<(String, String)>,
}

fn parse_options(args: &[String]) -> Result<Options> {
    let mut o = Options { words: vec![], limit: 20, prefix: String::new(), json: false, no_pull: false, base: None, message: None, copies: vec![] };
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--limit" | "-n" => {
                i += 1;
                o.limit = args.get(i).and_then(|v| v.parse().ok()).ok_or("--limit には数を付けてください")?;
            }
            "--prefix" => {
                i += 1;
                o.prefix = args.get(i).cloned().ok_or("--prefix にはフォルダを付けてください")?;
            }
            "--base" => {
                i += 1;
                o.base = Some(match args.get(i).map(String::as_str) {
                    Some("new") => None,
                    Some(sha) if is_sha(sha) => Some(sha.to_string()),
                    _ => return Err("--base には read --json で出た sha（40文字）か、まだないノートなら new を付けてください".into()),
                });
            }
            "--copy" => {
                i += 1;
                // 場所@読んだときの版（conflicts --json の copy と copySha）
                let copy = args.get(i).and_then(|c| c.rsplit_once('@')).filter(|(path, sha)| !path.is_empty() && is_sha(sha));
                let (path, sha) = copy.ok_or("--copy には「写しの場所@版」を付けてください（rootlore conflicts で出ます）")?;
                o.copies.push((path.to_string(), sha.to_string()));
            }
            "--message" | "-m" => {
                i += 1;
                let message = args.get(i).map(|m| m.trim().to_string()).filter(|m| !m.is_empty() && m.chars().count() <= 200 && !m.chars().any(char::is_control));
                o.message = Some(message.ok_or("--message には1行（200文字まで）の説明を付けてください")?);
            }
            "--json" => o.json = true,
            "--no-pull" => o.no_pull = true,
            other => o.words.push(other.to_string()),
        }
        i += 1;
    }
    Ok(o)
}

fn search(o: &Options) -> Result<()> {
    let words: Vec<String> = o.words.iter().flat_map(|w| w.split_whitespace()).map(str::to_lowercase).collect();
    if words.is_empty() {
        return Err("探す言葉を付けてください: rootlore search 議事録".into());
    }
    let store = fresh_store(o.no_pull)?;
    let notes = store.notes_dir();
    let mut results = vec![];
    for path in store.state.files.keys().filter(|p| p.starts_with(&o.prefix)) {
        let Ok(text) = fs::read_to_string(notes.join(path)) else { continue };
        let hay = format!("{}\n{}", path, text).to_lowercase();
        if !words.iter().all(|w| hay.contains(w.as_str())) {
            continue;
        }
        let lower_path = path.to_lowercase();
        let score: usize = words
            .iter()
            .map(|w| hay.matches(w.as_str()).count() + if lower_path.contains(w.as_str()) { 5 } else { 0 })
            .sum();
        let hits: Vec<Value> = text
            .lines()
            .enumerate()
            .filter(|(_, line)| {
                let l = line.to_lowercase();
                words.iter().any(|w| l.contains(w.as_str()))
            })
            .take(3)
            .map(|(n, line)| json!({ "line": n + 1, "text": line.chars().take(200).collect::<String>() }))
            .collect();
        results.push((score, path.clone(), hits));
    }
    results.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let total = results.len();
    results.truncate(o.limit);
    if o.json {
        let items: Vec<Value> = results.iter().map(|(s, p, h)| json!({ "path": p, "score": s, "hits": h })).collect();
        println!("{}", json!({ "total": total, "results": items }));
    } else {
        for (_, path, hits) in &results {
            println!("{path}");
            for hit in hits {
                println!("  {}: {}", hit["line"], hit["text"].as_str().unwrap_or(""));
            }
        }
        eprintln!("{total} 件{}", if total > results.len() { format!("（上位 {} 件を表示）", results.len()) } else { String::new() });
    }
    Ok(())
}

fn read(o: &Options) -> Result<()> {
    let name = note_name(o, "読むノートの場所を付けてください: rootlore read 0_AgentBrain/INDEX.md")?;
    let store = fresh_store(o.no_pull)?;
    if !store.state.files.contains_key(&name) {
        return Err(format!("ノートが見つかりません: {name}"));
    }
    let data = fs::read(store.notes_dir().join(&name)).map_err(|e| e.to_string())?;
    // UTF-8 でないノートを置き換え文字にして渡すと、それを直して送ったときに元の文字が壊れる
    let text = String::from_utf8(data.clone()).map_err(|_| format!("UTF-8 ではないノートは読めません: {name}"))?;
    if o.json {
        // sha は、このあと write --base に渡す（読んでから書くまでに GitHub で変わっても、気づける）。
        // 記録の版ではなく、読んだ中身から計算する（ほかの rootlore の取り込みと重なっても、本文と版がずれない）
        println!("{}", json!({ "path": name, "sha": git_blob_sha(&data), "text": text }));
    } else {
        print!("{text}");
    }
    Ok(())
}

fn is_sha(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn note_name(o: &Options, missing: &str) -> Result<String> {
    let path = o.words.first().ok_or(missing)?;
    Ok(if path.ends_with(".md") { path.clone() } else { format!("{path}.md") })
}

fn list(o: &Options) -> Result<()> {
    let store = fresh_store(o.no_pull)?;
    let paths: Vec<&String> = store.state.files.keys().filter(|p| p.starts_with(&o.prefix)).collect();
    if o.json {
        println!("{}", json!({ "total": paths.len(), "notes": paths }));
    } else {
        for p in paths {
            println!("{p}");
        }
    }
    Ok(())
}

fn status() -> Result<()> {
    let store = open_store().ok();
    let login = Api::new().and_then(|mut api| api.json("GET", "/.auth/me", None)).ok();
    println!("Rootlore: {}", base_url());
    match login.as_ref().and_then(|m| m["login"].as_str()) {
        Some(name) => println!("ログイン: {name}"),
        None => println!("ログイン: していません（rootlore login）"),
    }
    if let Some(store) = store {
        if let Some(repo) = &store.state.repo {
            println!("リポジトリ: {}/{}（{}）", repo.owner, repo.repo, repo.branch);
        }
        println!("ノート: {} 件", store.state.files.len());
        match store.state.synced_at {
            Some(t) => println!("最後に取り込んだ: {} 秒前", now_secs().saturating_sub(t)),
            None => println!("最後に取り込んだ: まだ"),
        }
        println!("写しの場所: {}", store.notes_dir().display());
    }
    Ok(())
}

// --- 書く ---

/** 1回で送れるノートの大きさ（Worker の MAX_FILE_BYTES と同じ） */
const MAX_NOTE_BYTES: usize = 1_048_576;
/** 食い違いが続いたときに、まとめ直す回数 */
const MAX_ROUNDS: usize = 3;
/** 食い違いのまとめを残したときの終了コード（AI やスクリプトが見分ける） */
const EXIT_CONFLICT: u8 = 3;

/** 書いた結果を、終了コードと一緒に返す */
struct Done {
    output: Value,
    conflict: bool,
}

enum Sent {
    Committed { commit: String, shas: HashMap<String, String> },
    /** GitHub で先に変わっていた。パス -> 今の SHA（消えていれば None） */
    Conflict(HashMap<String, Option<String>>),
}

fn stdin_text() -> Result<String> {
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err("本文を標準入力で渡してください（例: echo 本文 | rootlore write メモ.md）".into());
    }
    let mut buf = vec![];
    stdin.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    String::from_utf8(buf).map_err(|_| "本文が UTF-8 ではありません".into())
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}

/// 送ったが、書けたかどうかの返事を受け取れなかった（send の Err の先頭に付く）
const SENT_UNKNOWN: &str = "書き込みの返事を受け取れませんでした";

/// 返事を受け取れなかったとき、GitHub から取り込み直して、ノートが送った本文の版になっているかを確かめる。
/// なっていれば、その版を返す（書けていた）。送り直すと、append では同じ本文が二重に足されるため
fn confirm_after_unknown(api: &mut Api, path: &str, text: &str, cause: String) -> Result<String> {
    let sent = git_blob_sha(text.as_bytes());
    let store = pull(api).map_err(|e| {
        format!("{cause}。GitHub に書けたか確かめられませんでした（{e}）。送り直す前に、rootlore pull のあと rootlore read で確かめてください")
    })?;
    if store.state.files.get(path) == Some(&sent) {
        eprintln!("注意: 返事は受け取れませんでしたが、GitHub には書けていました。");
        return Ok(sent);
    }
    Err(format!(
        "{cause}。GitHub のノートは送った本文になっていないので、書けていないと思います。ほかの人が続けて変えたこともあるので、rootlore read で確かめてから送り直してください"
    ))
}

/// Worker の /api/gh/commit に送る。files は（場所、本文、読んだときの版）、deletions は（食い違いの写し、版）
fn send(api: &mut Api, files: &[(&str, &str, Option<&str>)], deletions: &[(&str, &str)], message: Option<&str>) -> Result<Sent> {
    for (path, text, _) in files {
        if text.len() > MAX_NOTE_BYTES {
            return Err(format!("大きすぎて送れません（1MB まで）: {path}"));
        }
    }
    let mut body = json!({
        "files": files.iter().map(|(p, t, b)| json!({ "path": p, "content": b64(t), "baseSha": b })).collect::<Vec<_>>(),
        "deletions": deletions.iter().map(|(p, b)| json!({ "path": p, "baseSha": b })).collect::<Vec<_>>(),
    });
    if let Some(m) = message {
        body["message"] = json!(m);
    }
    // 手元の写しのリポジトリを添える。ログインし直して別のリポジトリを選んだあと、古い写しの版で
    // 新しいリポジトリに書かないよう、Worker が照合する（違えば 412 {"error":"repo"}）
    let expected = open_store().ok().and_then(|s| s.state.repo).map(|r| format!("{}/{}", r.owner, r.repo));
    let headers: Vec<(&str, &str)> = expected.as_deref().map(|r| vec![("X-Rootlore-Repo", r)]).unwrap_or_default();
    let resp = api.call_allowing("POST", "/api/gh/commit", &headers, Some(&body.to_string()), Some(409)).map_err(|e| {
        if e.ends_with("HTTP 412") {
            return "開くリポジトリが切り替わっています。rootlore pull で取り込み直してから、もう一度送ってください".to_string();
        }
        // 送ったあとに切れた、Cloudflare が途中で打ち切った（500番台）なら、GitHub には書けていることがある
        let server_error = e.rsplit_once("HTTP ").is_some_and(|(_, code)| code.starts_with('5'));
        if e.starts_with("Rootlore に届きませんでした") || server_error {
            format!("{SENT_UNKNOWN}（{e}）")
        } else {
            e
        }
    })?;
    let status = resp.status();
    let value: Value = resp.into_json().map_err(|e| format!("{SENT_UNKNOWN}（返事を読めません: {e}）"))?;
    let entries = |key: &str| value[key].as_array().cloned().unwrap_or_default();
    if status == 409 {
        let current = entries("conflicts")
            .iter()
            .filter_map(|c| Some((c["path"].as_str()?.to_string(), c["sha"].as_str().map(str::to_string))))
            .collect();
        return Ok(Sent::Conflict(current));
    }
    let shas = entries("files")
        .iter()
        .filter_map(|f| Some((f["path"].as_str()?.to_string(), f["sha"].as_str()?.to_string())))
        .collect();
    let commit = value["commit"].as_str().ok_or("書き込みの返事にコミットがありません")?.to_string();
    Ok(Sent::Committed { commit, shas })
}

/// 送ったあとに、手元の写しも同じにする（次の取り込みを待たずに read で読める）。
/// written は（場所、本文、新しい版）、removed は消した写し
fn update_copy(written: &[(&str, &str, &str)], removed: &[&str]) -> Result<()> {
    let _lock = Lock::take(cache_root()?.join("pull.lock"), Duration::from_secs(600))?;
    let mut store = open_store()?;
    let notes = store.notes_dir();
    // 一覧が変わったので、次の取り込みでは必ず一覧を取り直す
    store.state.etag = None;
    for (path, _, _) in written {
        store.state.files.remove(*path);
    }
    for path in removed {
        store.state.files.remove(*path);
    }
    save_state(&store)?;
    for path in removed {
        let _ = fs::remove_file(notes.join(path));
    }
    for (path, text, sha) in written {
        write_atomic(&notes.join(path), text.as_bytes())?;
        store.state.files.insert(path.to_string(), sha.to_string());
    }
    save_state(&store)
}

/// GitHub に書けたあとの、手元の写しの更新。失敗しても書き込みは成り立っているので、注意だけ出す
/// （失敗として終わると、append を再実行して同じ本文を二重に足してしまう）
fn refresh_copy(written: &[(&str, &str, &str)], removed: &[&str]) {
    if let Err(e) = update_copy(written, removed) {
        eprintln!("注意: GitHub には書きましたが、手元の写しを更新できませんでした（{e}）。次の取り込みで直ります。");
    }
}

/// Git の blob SHA（"blob <長さ>\0" と中身の SHA-1）
fn git_blob_sha(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", data.len()).as_bytes());
    hasher.update(data);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA の版の本文。手元の写しが同じ版なら、GitHub に聞かない
fn text_at(api: &mut Api, store: &Store, path: &str, sha: Option<&str>) -> Result<String> {
    let Some(sha) = sha else { return Ok(String::new()) };
    // 写しは、ほかの rootlore の取り込みで書き換わっていることがある。中身から版を計算して確かめる
    if let Ok(data) = fs::read(store.notes_dir().join(path)) {
        if git_blob_sha(&data) == sha {
            if let Ok(text) = String::from_utf8(data) {
                return Ok(text);
            }
        }
    }
    let repo = store.state.repo.clone().ok_or("接続中のリポジトリが分かりません")?;
    String::from_utf8(blob_bytes(api, &repo, sha)?).map_err(|_| format!("UTF-8 ではないノートは、まとめられません: {path}"))
}

/// 3方向でまとめる。ぶつかったら Err に印付きのまとめ（どちらの本文も全部入っている）
fn merge3(ancestor: &str, mine: &str, theirs: &str) -> std::result::Result<String, String> {
    diffy::merge(ancestor, mine, theirs).map_err(|marked| {
        marked
            .lines()
            .map(|line| match line {
                "<<<<<<< ours" => "<<<<<<< この変更",
                "||||||| original" => "||||||| 元の版",
                ">>>>>>> theirs" => ">>>>>>> GitHub の今の版",
                other => other,
            })
            .collect::<Vec<_>>()
            .join("\n")
            + if marked.ends_with('\n') { "\n" } else { "" }
    })
}

/// 日時（UTC）。例 20261104-153000
fn stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    // 日数から年月日（Howard Hinnant の civil_from_days）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rest / 3600, rest / 60 % 60, rest % 60)
}

/// 食い違いの写しの場所。「日記/買い物.md」→「日記/買い物.conflicted-20261104-153000.md」
fn conflict_copy_name(path: &str, stamp: &str) -> String {
    format!("{}.conflicted-{stamp}.md", path.strip_suffix(".md").unwrap_or(path))
}

/// 食い違いの写しなら、元のノートの場所
fn conflict_original(path: &str) -> Option<String> {
    let stem = path.strip_suffix(".md")?;
    let (note, suffix) = stem.rsplit_once(".conflicted-")?;
    (!suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit() || b == b'-') && !note.ends_with('/') && !note.is_empty())
        .then(|| format!("{note}.md"))
}

fn check_writable(store: &Store, path: &str) -> Result<()> {
    if !is_note(path) {
        return Err(format!("書けない場所です（.md のノートだけ。隠しフォルダと Library/Std は除く）: {path}"));
    }
    if store.state.files.contains_key(path) {
        return Ok(());
    }
    // 大文字小文字だけが違うノートを作ると、Mac や Windows の写しで片方が消える
    let mut seen = CaseSeen::default();
    for existing in store.state.files.keys() {
        seen.take(existing);
    }
    if !seen.take(path) {
        return Err(format!("大文字小文字だけが違うノートやフォルダがあるので、書けません: {path}"));
    }
    Ok(())
}

/// 書く前の写し。まだ取り込んでいなければ、取り込む（読んでいないので、版は「新しいノート」になる）
fn store_for_write(api: &mut Api) -> Result<Store> {
    match open_store() {
        Ok(store) if store.state.repo.is_some() => Ok(store),
        _ => pull(api),
    }
}

fn write(o: &Options, append: bool) -> Result<Done> {
    let path = note_name(o, "書くノートの場所を付けてください: rootlore write 日記/メモ.md")?;
    let input = stdin_text()?;
    // 本文は標準入力でしか渡されていない。送れずに終わるときは、この PC に残して場所を知らせる
    write_inner(o, append, &path, &input).map_err(|e| match keep_locally(&path, &input, now_secs()) {
        Ok(file) => format!("{e}\n送ろうとした本文はこの PC に残しました: {}", file.display()),
        Err(_) => e,
    })
}

fn write_inner(o: &Options, append: bool, path: &str, input: &str) -> Result<Done> {
    let path = path.to_string();
    let mut api = Api::new()?;
    let store = store_for_write(&mut api)?;
    check_writable(&store, &path)?;
    // 読んだときの版。ここでは取り込まない（取り込むと、読んでからの GitHub の変更に気づけなくなる）。
    // 本文を丸ごと書くときは、手元の写しの版で代わりにしない（読んだあとに、ほかの rootlore が写しを新しくしていると、
    // その間の GitHub の変更を消してしまう）。足すだけなら、どの版に足しても最新の末尾に足し直すので、写しの版でよい
    let mut base: Option<String> = match (&o.base, append) {
        (Some(base), _) => base.clone(),
        (None, true) => store.state.files.get(&path).cloned(),
        (None, false) if store.state.files.contains_key(&path) => {
            return Err(format!(
                "このノートはもうあります。読んだときの版を --base で付けてください（rootlore read {path} --json の sha）"
            ))
        }
        (None, false) => None,
    };
    let mut merged = false;
    let message = o.message.as_deref();

    let mut text = if append {
        let current = text_at(&mut api, &store, &path, base.as_deref())?;
        join_append(&current, input)
    } else {
        input.to_string()
    };
    for _ in 0..MAX_ROUNDS {
        let sent = match send(&mut api, &[(&path, &text, base.as_deref())], &[], message) {
            Ok(sent) => sent,
            Err(e) if e.starts_with(SENT_UNKNOWN) => {
                let sha = confirm_after_unknown(&mut api, &path, &text, e)?;
                let status = if merged { "merged" } else { "committed" };
                return Ok(Done { output: json!({ "status": status, "path": path, "sha": sha, "commit": null }), conflict: false });
            }
            Err(e) => return Err(e),
        };
        match sent {
            Sent::Committed { commit, shas } => {
                let sha = shas.get(&path).cloned().ok_or("書き込みの返事に版がありません")?;
                refresh_copy(&[(&path, &text, &sha)], &[]);
                let status = if merged { "merged" } else { "committed" };
                return Ok(Done { output: json!({ "status": status, "path": path, "sha": sha, "commit": commit }), conflict: false });
            }
            Sent::Conflict(current) => {
                let now = current.get(&path).cloned().flatten();
                let theirs = text_at(&mut api, &store, &path, now.as_deref())?;
                if append {
                    // 足すだけなら、最新の末尾に足し直せばよい
                    text = join_append(&theirs, input);
                } else {
                    let ancestor = text_at(&mut api, &store, &path, base.as_deref())?;
                    match merge3(&ancestor, &text, &theirs) {
                        Ok(result) => text = result,
                        Err(marked) => return save_conflict(&mut api, &path, now, &marked, message),
                    }
                    merged = true;
                }
                base = now;
            }
        }
    }
    Err(format!("GitHub で続けて変わったので、書けませんでした。少し待って、もう一度試してください: {path}"))
}

fn join_append(current: &str, addition: &str) -> String {
    if current.is_empty() || current.ends_with('\n') {
        format!("{current}{addition}")
    } else {
        format!("{current}\n{addition}")
    }
}

/// GitHub に残せない本文を、この PC に残す。名前に乱数を付け、すでにあるファイルは置き換えない
fn keep_locally(path: &str, text: &str, now: u64) -> Result<PathBuf> {
    let dir = private_dir(cache_root()?.join("recovered"))?;
    let name = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md");
    for _ in 0..5 {
        let file = dir.join(format!("{name}.{}-{}.md", stamp(now), random_hex(4)));
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&file) {
            Ok(mut f) => {
                std::io::Write::write_all(&mut f, text.as_bytes()).map_err(|e| format!("{}: {e}", file.display()))?;
                return Ok(file);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", file.display())),
        }
    }
    Err("この PC に残すファイルを作れませんでした".into())
}

/// GitHub のノートには触らず、印付きのまとめを隣の写しに残す
fn save_conflict(api: &mut Api, path: &str, theirs_sha: Option<String>, marked: &str, message: Option<&str>) -> Result<Done> {
    let now = now_secs();
    // GitHub に残せなければ（大きすぎる、送れない）、この PC に残して場所を知らせる。本文は標準入力でしか渡されていないので、なくさない
    let keep_here = |reason: String| -> Result<Done> {
        let file = keep_locally(path, marked, now)?;
        eprintln!("注意: まとめを GitHub に残せませんでした（{reason}）。");
        Ok(Done {
            output: json!({ "status": "conflicted", "path": path, "sha": theirs_sha, "conflictCopy": null, "recovered": file.display().to_string() }),
            conflict: true,
        })
    };
    if marked.len() > MAX_NOTE_BYTES {
        return keep_here("1MB を超えます".into());
    }
    for n in 0..5u64 {
        let copy = conflict_copy_name(path, &stamp(now + n));
        let note = format!("Rootlore: {} の食い違いを残す", path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md"));
        let sent = match send(api, &[(&copy, marked, None)], &[], Some(message.unwrap_or(&note))) {
            Ok(sent) => sent,
            Err(e) => return keep_here(e),
        };
        match sent {
            Sent::Committed { commit, shas } => {
                let sha = shas.get(&copy).cloned().ok_or("書き込みの返事に版がありません")?;
                refresh_copy(&[(&copy, marked, &sha)], &[]);
                return Ok(Done {
                    output: json!({
                        "status": "conflicted",
                        "path": path,
                        "sha": theirs_sha,
                        "conflictCopy": copy,
                        "commit": commit,
                    }),
                    conflict: true,
                });
            }
            // 同じ名前の写しがもうある（同じ秒に2回ぶつかった）。名前を変える
            Sent::Conflict(_) => continue,
        }
    }
    keep_here("同じ名前の写しが続けてありました".into())
}

struct ConflictEntry {
    note: String,
    note_sha: Option<String>,
    copy: String,
    copy_sha: String,
}

fn conflict_entries(store: &Store) -> Vec<ConflictEntry> {
    store
        .state
        .files
        .iter()
        .filter_map(|(path, sha)| {
            let note = conflict_original(path)?;
            Some(ConflictEntry { note_sha: store.state.files.get(&note).cloned(), note, copy: path.clone(), copy_sha: sha.clone() })
        })
        .collect()
}

fn conflicts(o: &Options) -> Result<()> {
    let store = fresh_store(o.no_pull)?;
    let entries = conflict_entries(&store);
    if o.json {
        let items: Vec<Value> = entries
            .iter()
            .map(|e| json!({ "note": e.note, "noteSha": e.note_sha, "copy": e.copy, "copySha": e.copy_sha }))
            .collect();
        println!("{}", json!({ "total": items.len(), "conflicts": items }));
    } else {
        for e in &entries {
            println!("{}（版 {}）\n  まとめ: {}@{}", e.note, e.note_sha.as_deref().unwrap_or("new"), e.copy, e.copy_sha);
        }
        eprintln!("{} 件", entries.len());
    }
    Ok(())
}

fn resolve(o: &Options) -> Result<Done> {
    let path = note_name(o, "直すノートの場所を付けてください: rootlore resolve 日記/メモ.md")?;
    let text = stdin_text()?;
    let mut api = Api::new()?;
    // conflicts で見た写しの版で送る（そのあと GitHub で変わっていれば、断られる）
    let store = store_for_write(&mut api)?;
    check_writable(&store, &path)?;
    let entries: Vec<ConflictEntry> = conflict_entries(&store).into_iter().filter(|e| e.note == path).collect();
    if entries.is_empty() {
        return Err(format!("このノートの食い違いはありません（rootlore conflicts で一覧）: {path}"));
    }
    // 消すのは、読んで直した写しだけ（直している間に増えた写しは、読んでいないので消さない）
    if o.copies.is_empty() {
        let list: Vec<String> = entries.iter().map(|e| format!("  --copy {}@{}", e.copy, e.copy_sha)).collect();
        return Err(format!("読んで直した食い違いの写しを --copy で指定してください:\n{}", list.join("\n")));
    }
    let Some(base) = o.base.clone() else {
        return Err(format!("読んだときのノートの版を --base で付けてください（rootlore conflicts --json の noteSha。ノートがなければ new）: {path}"));
    };
    // 消す写しの版は、読んだときのもの（手元の写しの版を使うと、読んだあとに GitHub で書き足された写しまで消してしまう）
    let mut deletions: Vec<(&str, &str)> = vec![];
    for (copy, sha) in &o.copies {
        if conflict_original(copy).as_deref() != Some(path.as_str()) {
            return Err(format!("このノートの食い違いの写しではありません: {copy}"));
        }
        if !deletions.iter().any(|(c, _)| c == copy) {
            deletions.push((copy.as_str(), sha.as_str()));
        }
    }
    let name = path.rsplit('/').next().unwrap_or(&path).trim_end_matches(".md").to_string();
    let message = o.message.clone().unwrap_or_else(|| format!("Rootlore: {name} の食い違いを直す"));
    // 直した本文は標準入力でしか渡されていない。送れずに終わるときは、この PC に残して場所を知らせる
    let keep = |e: String, text: &str| match keep_locally(&path, text, now_secs()) {
        Ok(file) => format!("{e}\n直した本文はこの PC に残しました: {}", file.display()),
        Err(_) => e,
    };
    let mut text = text;
    let mut base = base;
    for _ in 0..MAX_ROUNDS {
        let sent = match send(&mut api, &[(&path, &text, base.as_deref())], &deletions, Some(&message)) {
            Ok(sent) => sent,
            Err(e) if e.starts_with(SENT_UNKNOWN) => {
                // ノートと写しの削除は1つのコミットなので、ノートが直した本文になっていれば、写しも消えている
                let sha = confirm_after_unknown(&mut api, &path, &text, e).map_err(|e| keep(e, &text))?;
                let removed: Vec<&str> = deletions.iter().map(|(p, _)| *p).collect();
                return Ok(Done { output: json!({ "status": "resolved", "path": path, "sha": sha, "commit": null, "removed": removed }), conflict: false });
            }
            Err(e) => return Err(keep(e, &text)),
        };
        let current = match sent {
            Sent::Committed { commit, shas } => {
                let sha = shas.get(&path).cloned().ok_or("書き込みの返事に版がありません")?;
                let removed: Vec<&str> = deletions.iter().map(|(p, _)| *p).collect();
                refresh_copy(&[(&path, &text, &sha)], &removed);
                return Ok(Done { output: json!({ "status": "resolved", "path": path, "sha": sha, "commit": commit, "removed": removed }), conflict: false });
            }
            Sent::Conflict(current) => current,
        };
        // 読んだ写しが変わった（書き足された）。読んでいない中身を消すことになるので、まとめずに止める
        if deletions.iter().any(|(copy, _)| current.contains_key(*copy)) {
            return Err(keep(
                format!("直している間に、GitHub で食い違いの写しが変わりました。rootlore conflicts で読み直してから、もう一度直してください: {path}"),
                &text,
            ));
        }
        // ノートだけが変わった。ふつうの書き込みと同じく3方向でまとめ、ぶつかったら新しい写しに残す
        let now = current.get(&path).cloned().flatten();
        let ancestor = text_at(&mut api, &store, &path, base.as_deref()).map_err(|e| keep(e, &text))?;
        let theirs = text_at(&mut api, &store, &path, now.as_deref()).map_err(|e| keep(e, &text))?;
        match merge3(&ancestor, &text, &theirs) {
            Ok(result) => text = result,
            Err(marked) => return save_conflict(&mut api, &path, now, &marked, o.message.as_deref()),
        }
        base = now;
    }
    Err(keep(format!("GitHub で続けて変わったので、書けませんでした。少し待って、もう一度試してください: {path}"), &text))
}

fn print_done(done: &Done, json_out: bool) {
    if json_out {
        println!("{}", done.output);
        return;
    }
    let path = done.output["path"].as_str().unwrap_or("");
    match done.output["status"].as_str() {
        Some("committed") => println!("書きました: {path}"),
        Some("merged") => println!("GitHub の変更とまとめて書きました: {path}"),
        Some("resolved") => println!("食い違いを直しました: {path}"),
        _ => {
            println!("GitHub のノートと同じ所が食い違ったので、ノートはそのままにして、まとめを残しました。");
            if let Some(file) = done.output["recovered"].as_str() {
                println!("  ノート: {path}\n  まとめ（この PC）: {file}");
                println!("  まとめを読んで直し、rootlore write {path} --base <GitHub の今の版> で送ってください。");
            } else {
                println!("  ノート: {path}\n  まとめ: {}", done.output["conflictCopy"].as_str().unwrap_or(""));
                println!("  rootlore conflicts で版を確かめ、直した本文を rootlore resolve {path} --base <版> --copy <写し@版> で送ってください。");
            }
        }
    }
}


const HELP: &str = "rootlore — Rootlore の CLI。GitHub が正本の Vault を読む・探す・書く

使い方:
  rootlore login                 ふだんのブラウザでログインする
  rootlore logout                この PC のログインを消す
  rootlore search <言葉…>        取り込んでから探す（空白で区切ると、全部を含むノート）
  rootlore read <場所>           取り込んでから読む（例: 0_AgentBrain/INDEX.md）
  rootlore list                  ノートの場所の一覧
  rootlore pull                  取り込むだけ
  rootlore status                ログイン、ノートの件数、写しの場所
  rootlore path                  写しの場所（rg などで直接探すとき。読むだけにすること）

書く（本文は標準入力で渡す）:
  rootlore write <場所> --base <版>  ノートを丸ごと書く。版は read --json の sha（まだないノートは --base new か省く）
  rootlore append <場所>         ノートの末尾に足す（GitHub で先に変わっていても、最新の末尾に足す）
  rootlore conflicts             食い違いの一覧（ノートと、印付きのまとめを残した写し）
  rootlore resolve <場所> --base <版> --copy <写し@版>  直した本文を送り、読んだ食い違いの写しを消す

  write で GitHub が先に変わっていたら、3方向でまとめて送る。同じ所がぶつかったときは、GitHub のノートは
  そのままにして、印（<<<<<<< 〜 >>>>>>>）付きのまとめを「ノート名.conflicted-日時.md」に残し、終了コード 3 で終わる。
  conflicts で版を確かめて読み、直した本文を resolve で送る（--copy に、読んだ写しを1つずつ付ける）。
  まとめが大きすぎるなどで GitHub に残せないときは、この PC に残して場所を知らせる（同じく終了コード 3）。

オプション:
  --limit N    search の件数（標準 20）
  --prefix P   フォルダで絞る（例: 0_AgentBrain/）
  --json       機械が読む形で出す
  --no-pull    取り込まずに、前回の写しで答える（最後の取り込みから30秒以内も、取り込まない）
  --base SHA   読んだときの版（read --json の sha。まだないノートは new）。append では省ける
  --message M  コミットの説明（1行）
  --copy P@SHA resolve で消す食い違いの写しと、読んだときの版（いくつでも）
";

fn run(args: Vec<String>) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("help");
    let rest = &args[args.len().min(1)..];
    match command {
        "login" => login(),
        "logout" => {
            let _ = fs::remove_file(session_path()?);
            println!("この PC のログインを消しました。");
            Ok(())
        }
        "search" => search(&parse_options(rest)?),
        "read" => read(&parse_options(rest)?),
        "list" => list(&parse_options(rest)?),
        "write" | "append" | "resolve" => {
            let o = parse_options(rest)?;
            let done = if command == "resolve" { resolve(&o)? } else { write(&o, command == "append")? };
            print_done(&done, o.json);
            if done.conflict {
                std::process::exit(EXIT_CONFLICT as i32);
            }
            Ok(())
        }
        "conflicts" => conflicts(&parse_options(rest)?),
        "pull" => {
            let store = pull(&mut Api::new()?)?;
            println!("{} 件", store.state.files.len());
            Ok(())
        }
        "status" => status(),
        "path" => {
            println!("{}", open_store()?.notes_dir().display());
            Ok(())
        }
        "help" | "--help" | "-h" => {
            print!("{HELP}");
            Ok(())
        }
        "--version" | "-V" => {
            println!("rootlore {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        other => Err(format!("知らないコマンドです: {other}（rootlore help）")),
    }
}

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("rootlore: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_note;

    #[test]
    fn notes_must_stay_inside_the_copy() {
        assert!(is_note("0_AgentBrain/INDEX.md"));
        assert!(is_note("日記/2026 11#3?.md"));
        for bad in ["C:\\Users\\Alice\\report.md", "C:report.md", "a\\..\\..\\b.md", "a/../b.md", "/etc/x.md", ".obsidian/x.md", "a//b.md", "Library/Std/x.md", "a/b.txt"] {
            assert!(!is_note(bad), "{bad}");
        }
    }
}

#[cfg(test)]
mod segment_tests {
    use super::path_segment;

    #[test]
    fn branch_names_become_one_url_segment() {
        assert_eq!(path_segment("main"), "main");
        assert_eq!(path_segment("feature/cli"), "feature%2Fcli");
        assert_eq!(path_segment("日本"), "%E6%97%A5%E6%9C%AC");
    }
}

/// 大文字小文字を区別しないファイルシステム（Mac、Windows）で、同じ場所になってしまうノートを見つける。
/// ファイルどうし（A.md と a.md）だけでなく、ファイルとフォルダ（A.md と a.md/b.md）の重なりも見る
#[derive(Default)]
struct CaseSeen {
    files: HashSet<String>,
    dirs: HashSet<String>,
}

impl CaseSeen {
    /// 重ならなければ覚えて true
    fn take(&mut self, path: &str) -> bool {
        let lower = path.to_lowercase();
        let parents: Vec<String> = lower.match_indices('/').map(|(i, _)| lower[..i].to_string()).collect();
        if self.files.contains(&lower) || self.dirs.contains(&lower) || parents.iter().any(|p| self.files.contains(p)) {
            return false;
        }
        self.files.insert(lower);
        self.dirs.extend(parents);
        true
    }
}

#[cfg(test)]
mod case_tests {
    use super::CaseSeen;

    #[test]
    fn notes_that_would_share_a_place_are_skipped() {
        let mut seen = CaseSeen::default();
        assert!(seen.take("A.md"));
        assert!(!seen.take("a.md"));
        assert!(!seen.take("a.md/b.md"));
        assert!(seen.take("Notes/x.md"));
        assert!(seen.take("notes/y.md"));
        assert!(!seen.take("NOTES"));
        assert!(!seen.take("notes/X.md"));
    }
}

#[cfg(test)]
mod write_tests {
    use super::{conflict_copy_name, conflict_original, git_blob_sha, join_append, merge3, stamp};

    #[test]
    fn blob_sha_matches_git_hash_object() {
        // printf 'hello\n' | git hash-object --stdin
        assert_eq!(git_blob_sha(b"hello
"), "ce013625030ba8dba906f756967f9e9ca394464a");
        assert_eq!(git_blob_sha(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }

    #[test]
    fn stamps_are_utc_date_and_time() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_793_806_200), "20261104-153000");
        assert_eq!(stamp(951_782_400), "20000229-000000");
    }

    #[test]
    fn conflict_copies_point_back_to_their_note() {
        let copy = conflict_copy_name("日記/買い物.md", "20261104-153000");
        assert_eq!(copy, "日記/買い物.conflicted-20261104-153000.md");
        assert_eq!(conflict_original(&copy).as_deref(), Some("日記/買い物.md"));
        assert_eq!(conflict_original("日記/買い物.md"), None);
        assert_eq!(conflict_original("a.conflicted-.md"), None);
        assert_eq!(conflict_original("a.conflicted-x1.md"), None);
        assert_eq!(conflict_original(".conflicted-1.md"), None);
        // 名前が .md.md のノートの写しは、.md のノートと取り違えない
        assert_eq!(conflict_original(&conflict_copy_name("a.md.md", "1")).as_deref(), Some("a.md.md"));
    }

    #[test]
    fn changes_in_different_places_merge() {
        let base = "a\nb\nc\nd\ne\n";
        assert_eq!(merge3(base, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n").unwrap(), "A\nb\nc\nd\nE\n");
    }

    #[test]
    fn changes_in_the_same_place_keep_both_with_marks() {
        let marked = merge3("a\nb\n", "a\nmine\n", "a\ntheirs\n").unwrap_err();
        assert!(marked.contains("<<<<<<< この変更\nmine\n"), "{marked}");
        assert!(marked.contains("||||||| 元の版\nb\n"), "{marked}");
        assert!(marked.contains("=======\ntheirs\n>>>>>>> GitHub の今の版\n"), "{marked}");
    }

    #[test]
    fn appends_start_on_a_new_line() {
        assert_eq!(join_append("", "x\n"), "x\n");
        assert_eq!(join_append("a\n", "x\n"), "a\nx\n");
        assert_eq!(join_append("a", "x\n"), "a\nx\n");
    }
}
