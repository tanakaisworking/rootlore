//! トークンで直接つないだときの書き込み（保存・移動・削除）。うちのサーバーを通さない約束なので、
//! Worker の worker/commit.ts・move.ts・delete.ts と同じ決まりと確かめ方を、ここで GitHub に直接行う。
//! 書いてよい場所、読んだときの版との突き合わせ、間に別のコミットが入ったときのやり直し、返事の形を Worker とそろえる。
//! GitHub の Git Data API で、blob → tree → commit → ref（force:false）の順に進める（worker/tree_edit.ts と同じ道）。
use serde_json::{json, Value};

const API: &str = "https://api.github.com";
const MAX_FILES: usize = 100;
const MAX_FILE_BYTES: usize = 1_048_576;
const MAX_TOTAL_BYTES: usize = 10 * 1_048_576;
const MAX_MESSAGE: usize = 200;
const MAX_ATTEMPTS: usize = 3;

/// 返事（HTTP の状態と JSON）。中継がそのまま画面に返す
pub type Reply = (u16, Value);

pub struct Target<'a> {
    pub token: &'a str,
    pub owner: &'a str,
    pub repo: &'a str,
    pub branch: &'a str,
}

/// /commit・/move・/delete を受ける。expected は画面が添えたリポジトリ（X-Rootlore-Repo）
pub fn handle(rest: &str, body: &[u8], expected: Option<&str>, target: &Target) -> Reply {
    if let Some(expected) = expected {
        if !expected.eq_ignore_ascii_case(&format!("{}/{}", target.owner, target.repo)) {
            return (412, json!({ "error": "repo" }));
        }
    }
    let Ok(body) = serde_json::from_slice::<Value>(body) else { return (400, json!({ "error": "invalid" })) };
    let result = match rest {
        "/commit" => match parse_commit(&body) {
            Some(request) => commit(target, &request),
            None => return (400, json!({ "error": "invalid" })),
        },
        "/move" => match parse_move(&body) {
            Some(request) => move_file(target, &request),
            None => return (400, json!({ "error": "invalid" })),
        },
        "/delete" => match parse_delete(&body) {
            Some(request) => delete_file(target, &request),
            None => return (400, json!({ "error": "invalid" })),
        },
        _ => return (404, json!({ "error": "not-found" })),
    };
    match result {
        Ok(reply) => reply,
        Err(Failure::Unauthorized) => (401, json!({ "error": "refresh" })),
        Err(Failure::Other(message)) => {
            crate::log(&json!({ "stage": "direct-write-error", "what": rest, "error": message }).to_string());
            (502, json!({ "error": "github" }))
        }
    }
}

// --- 書いてよい場所（worker/commit.ts・tree_edit.ts と同じ） ---

fn bad_chars(path: &str) -> bool {
    path.chars().any(|c| c == '\\' || c == ':' || (c as u32) < 0x20 || c as u32 == 0x7f)
}

fn plain_segments(path: &str) -> bool {
    path.split('/').all(|p| !p.is_empty() && !p.starts_with('.'))
}

/// 移動・削除できる場所（tree_edit.ts の isEditablePath）
pub fn editable_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 1024 && !path.starts_with("Library/Std/") && !bad_chars(path) && plain_segments(path)
}

fn skill_id(id: &str) -> bool {
    !id.is_empty()
        && id.split('-').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

fn skill_path(path: &str) -> bool {
    path.strip_prefix(".claude/skills/").and_then(|rest| rest.strip_suffix("/SKILL.md")).is_some_and(skill_id)
}

fn skill_link_path(path: &str) -> bool {
    path.strip_prefix(".agents/skills/").is_some_and(skill_id)
}

fn skill_link_target(path: &str, target: &str) -> bool {
    target == format!("../../.claude/skills/{}", path.rsplit('/').next().unwrap_or(""))
}

/// 保存できる場所（commit.ts の isWritablePath）。Markdown のノートと .base だけで、隠しフォルダと同梱の標準ライブラリは除く
pub fn writable_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 1024 || !(path.ends_with(".md") || path.ends_with(".base")) || path.starts_with("Library/Std/") || bad_chars(path) {
        return false;
    }
    skill_path(path) || plain_segments(path)
}

/// 食い違いの写し（ノート名.conflicted-日時.md）。保存と一緒に消してよいのはこれだけ
fn conflict_copy(path: &str) -> bool {
    writable_path(path)
        && path
            .strip_suffix(".md")
            .and_then(|p| p.rsplit_once(".conflicted-"))
            .is_some_and(|(_, stamp)| !stamp.is_empty() && stamp.chars().all(|c| c.is_ascii_digit() || c == '-'))
}

fn sha(value: &Value) -> Option<String> {
    let s = value.as_str()?;
    (s.len() == 40 && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))).then(|| s.to_string())
}

/// null か SHA。ほかは None（形が違う）
fn base(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        Some(Value::Null) => Some(None),
        Some(v) => sha(v).map(Some),
        None => None,
    }
}

fn base64_bytes(content: &str) -> Option<usize> {
    let ok = content.len() % 4 == 0 && content.trim_end_matches('=').chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/');
    if !ok || content.len() - content.trim_end_matches('=').len() > 2 {
        return None;
    }
    let padding = content.len() - content.trim_end_matches('=').len();
    Some(content.len() / 4 * 3 - padding)
}

// --- 受け取る形 ---

#[derive(Debug)]
pub struct FileWrite {
    path: String,
    content: String,
    base: Option<String>,
}
#[derive(Debug)]
pub struct LinkWrite {
    path: String,
    target: String,
    base: Option<String>,
}
#[derive(Debug)]
pub struct CommitRequest {
    files: Vec<FileWrite>,
    links: Vec<LinkWrite>,
    deletions: Vec<(String, String)>,
    message: Option<String>,
}

pub fn parse_commit(body: &Value) -> Option<CommitRequest> {
    let files = body.get("files")?.as_array()?;
    let empty: Vec<Value> = Vec::new();
    let links = match body.get("symlinks") { Some(v) => v.as_array()?, None => &empty };
    let deletions = match body.get("deletions") { Some(v) => v.as_array()?, None => &empty };
    if files.is_empty() || files.len() + links.len() + deletions.len() > MAX_FILES {
        return None;
    }
    let message = match body.get("message") {
        None => None,
        Some(v) => {
            let m = v.as_str()?;
            if m.trim().is_empty() || m.chars().count() > MAX_MESSAGE || m.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
                return None;
            }
            Some(m.trim().to_string())
        }
    };
    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    let mut parsed = Vec::new();
    for file in files {
        let path = file.get("path")?.as_str()?;
        if !writable_path(path) || !seen.insert(path.to_string()) {
            return None;
        }
        let content = file.get("content")?.as_str()?;
        let bytes = base64_bytes(content)?;
        total += bytes;
        if bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
            return None;
        }
        parsed.push(FileWrite { path: path.into(), content: content.into(), base: base(file.get("baseSha"))? });
    }
    let mut parsed_links = Vec::new();
    for link in links {
        let path = link.get("path")?.as_str()?;
        let target = link.get("target")?.as_str()?;
        if !skill_link_path(path) || !skill_link_target(path, target) || !seen.insert(path.to_string()) {
            return None;
        }
        parsed_links.push(LinkWrite { path: path.into(), target: target.into(), base: base(link.get("baseSha"))? });
    }
    let mut parsed_deletions = Vec::new();
    for deletion in deletions {
        let path = deletion.get("path")?.as_str()?;
        if !conflict_copy(path) || !seen.insert(path.to_string()) {
            return None;
        }
        parsed_deletions.push((path.to_string(), sha(deletion.get("baseSha")?)?));
    }
    Some(CommitRequest { files: parsed, links: parsed_links, deletions: parsed_deletions, message })
}

/// 移動（move.ts と同じ）。base が None ならフォルダの移動（コミットする時点の中身を丸ごと付け替える）
pub fn parse_move(body: &Value) -> Option<(String, String, Option<String>)> {
    let source = body.get("source")?.as_str()?;
    let destination = body.get("destination")?.as_str()?;
    if !editable_path(source) || !editable_path(destination) || source == destination
        || destination.starts_with(&format!("{source}/")) || source.starts_with(&format!("{destination}/"))
    {
        return None;
    }
    let base = if body.get("folder") == Some(&Value::Bool(true)) { None } else { Some(sha(body.get("baseSha")?)?) };
    Some((source.into(), destination.into(), base))
}

pub fn parse_delete(body: &Value) -> Option<(String, String)> {
    let path = body.get("path")?.as_str()?;
    editable_path(path).then_some(())?;
    Some((path.into(), sha(body.get("baseSha")?)?))
}

/// コミットメッセージ（commit.ts の commitHeadline と同じ）。例「Rootlore: 買い物メモ ほか2件」
fn headline(paths: &[&str]) -> String {
    let name = paths[0].rsplit('/').next().unwrap_or("").trim_end_matches(".md");
    if paths.len() > 1 { format!("Rootlore: {name} ほか{}件", paths.len() - 1) } else { format!("Rootlore: {name}") }
}

// --- GitHub ---

enum Failure {
    Unauthorized,
    Other(String),
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Other(message)
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Found {
    Missing,
    Blocked,
    Entry { sha: String, mode: String, kind: String },
}

struct GitHub<'a> {
    agent: ureq::Agent,
    target: &'a Target<'a>,
}

impl<'a> GitHub<'a> {
    fn new(target: &'a Target<'a>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(60))
            .build();
        GitHub { agent, target }
    }

    /// 返事の状態が 2xx なら JSON、422 は Ok(None)（ブランチが先に進んだ）、401 は Unauthorized
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Option<Value>, Failure> {
        let url = format!("{API}/repos/{}/{}/git{path}", self.target.owner, self.target.repo);
        let request = self
            .agent
            .request(method, &url)
            .set("Accept", "application/vnd.github+json")
            .set("X-GitHub-Api-Version", "2022-11-28")
            .set("User-Agent", "rootlore")
            .set("Authorization", &format!("Bearer {}", self.target.token));
        let result = match body {
            Some(body) => request.set("Content-Type", "application/json").send_string(&body.to_string()),
            None => request.call(),
        };
        match result {
            Ok(response) => response.into_json::<Value>().map(Some).map_err(|e| Failure::Other(e.to_string())),
            Err(ureq::Error::Status(401, _)) => Err(Failure::Unauthorized),
            Err(ureq::Error::Status(409 | 422, _)) if method == "PATCH" => Ok(None),
            Err(e) => Err(Failure::Other(format!("{method} {path}: {e}"))),
        }
    }

    fn json(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, Failure> {
        self.call(method, path, body)?.ok_or_else(|| Failure::Other(format!("{method} {path}: no body")))
    }

    fn ref_path(&self) -> String {
        self.target.branch.split('/').map(|p| p.replace('%', "%25").replace('#', "%23").replace('?', "%3F")).collect::<Vec<_>>().join("/")
    }

    fn head(&self) -> Result<String, Failure> {
        let data = self.json("GET", &format!("/ref/heads/{}", self.ref_path()), None)?;
        data["object"]["sha"].as_str().and_then(|s| sha(&Value::String(s.into()))).ok_or_else(|| Failure::Other("no branch head".into()))
    }

    /// 先頭のコミットの tree で、各パスの今の状態を辿る（tree_edit.ts の entry と同じ）
    fn find(&self, root: &str, paths: &[&str]) -> Result<Vec<Found>, Failure> {
        let mut trees: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
        let mut out = Vec::new();
        for path in paths {
            let parts: Vec<&str> = path.split('/').collect();
            let mut sha_now = root.to_string();
            let mut found = Found::Missing;
            for (i, part) in parts.iter().enumerate() {
                if !trees.contains_key(&sha_now) {
                    let tree = self.json("GET", &format!("/trees/{sha_now}"), None)?;
                    if tree["truncated"].as_bool() == Some(true) {
                        return Err(Failure::Other("incomplete tree".into()));
                    }
                    let entries = tree["tree"].as_array().cloned().ok_or_else(|| Failure::Other("no tree".into()))?;
                    trees.insert(sha_now.clone(), entries);
                }
                let entry = trees[&sha_now].iter().find(|e| e["path"].as_str() == Some(part)).cloned();
                let Some(entry) = entry else { break };
                let kind = entry["type"].as_str().unwrap_or("").to_string();
                let entry_sha = entry["sha"].as_str().unwrap_or("").to_string();
                if i == parts.len() - 1 {
                    found = Found::Entry { sha: entry_sha, mode: entry["mode"].as_str().unwrap_or("100644").to_string(), kind };
                } else if kind != "tree" {
                    found = Found::Blocked;
                    break;
                } else {
                    sha_now = entry_sha;
                }
            }
            out.push(found);
        }
        Ok(out)
    }

    /// 確かめてから書き換える。plan が Err を返したら、書き換えずにその返事を返す
    fn edit(&self, paths: &[&str], plan: impl Fn(&[Found]) -> Result<(Vec<Value>, String), Reply>) -> Result<Result<String, Reply>, Failure> {
        for _ in 0..MAX_ATTEMPTS {
            let oid = self.head()?;
            let commit = self.json("GET", &format!("/commits/{oid}"), None)?;
            let root = commit["tree"]["sha"].as_str().ok_or_else(|| Failure::Other("no commit tree".into()))?.to_string();
            let found = self.find(&root, paths)?;
            let (changes, message) = match plan(&found) {
                Ok(decided) => decided,
                Err(reply) => return Ok(Err(reply)),
            };
            let tree = self.json("POST", "/trees", Some(json!({ "base_tree": root, "tree": changes })))?;
            let next = self.json("POST", "/commits", Some(json!({ "message": message, "tree": tree["sha"], "parents": [oid] })))?;
            let next_sha = next["sha"].as_str().unwrap_or("").to_string();
            match self.call("PATCH", &format!("/refs/heads/{}", self.ref_path()), Some(json!({ "sha": next_sha, "force": false })))? {
                Some(_) => return Ok(Ok(next_sha)),
                None => continue, // 確かめてから進めるまでの間に、誰かがブランチを進めた。確かめ直す
            }
        }
        Err(Failure::Other("the branch kept moving".into()))
    }
}

fn current_sha(found: &Found) -> Option<String> {
    match found {
        Found::Entry { sha, kind, .. } if kind == "blob" => Some(sha.clone()),
        _ => None,
    }
}

fn commit(target: &Target, request: &CommitRequest) -> Result<Reply, Failure> {
    let gh = GitHub::new(target);
    // 中身は先に GitHub に置く（やり直しても同じ blob を使う）
    let mut blobs = Vec::new();
    for file in &request.files {
        let blob = gh.json("POST", "/blobs", Some(json!({ "content": file.content, "encoding": "base64" })))?;
        blobs.push(blob["sha"].as_str().unwrap_or("").to_string());
    }
    let mut link_blobs = Vec::new();
    for link in &request.links {
        let blob = gh.json("POST", "/blobs", Some(json!({ "content": link.target, "encoding": "utf-8" })))?;
        link_blobs.push(blob["sha"].as_str().unwrap_or("").to_string());
    }
    let mut paths: Vec<&str> = request.files.iter().map(|f| f.path.as_str()).collect();
    paths.extend(request.links.iter().map(|l| l.path.as_str()));
    paths.extend(request.deletions.iter().map(|(p, _)| p.as_str()));
    let mut bases: Vec<Option<String>> = request.files.iter().map(|f| f.base.clone()).collect();
    bases.extend(request.links.iter().map(|l| l.base.clone()));
    bases.extend(request.deletions.iter().map(|(_, b)| Some(b.clone())));
    let file_paths: Vec<&str> = request.files.iter().map(|f| f.path.as_str()).collect();
    let message = format!("{}\n\n{}", request.message.clone().unwrap_or_else(|| headline(&file_paths)), paths.join("\n"));
    let outcome = gh.edit(&paths, |found| {
        let mut conflicts = Vec::new();
        for (i, f) in found.iter().enumerate() {
            if *f == Found::Blocked || matches!(f, Found::Entry { kind, .. } if kind != "blob") {
                return Err((409, json!({ "conflicts": [{ "path": paths[i], "sha": Value::Null }] })));
            }
            let now = current_sha(f);
            if now != bases[i] {
                conflicts.push(json!({ "path": paths[i], "sha": now }));
            }
        }
        if !conflicts.is_empty() {
            return Err((409, json!({ "conflicts": conflicts })));
        }
        let mut changes = Vec::new();
        for (file, blob) in request.files.iter().zip(&blobs) {
            changes.push(json!({ "path": file.path, "mode": "100644", "type": "blob", "sha": blob }));
        }
        for (link, blob) in request.links.iter().zip(&link_blobs) {
            changes.push(json!({ "path": link.path, "mode": "120000", "type": "blob", "sha": blob }));
        }
        for (path, _) in &request.deletions {
            changes.push(json!({ "path": path, "mode": "100644", "type": "blob", "sha": Value::Null }));
        }
        Ok((changes, message.clone()))
    })?;
    Ok(match outcome {
        Ok(commit) => {
            let files: Vec<Value> = request.files.iter().zip(&blobs).map(|(f, s)| json!({ "path": f.path, "sha": s })).collect();
            (200, json!({ "commit": commit, "files": files }))
        }
        Err(reply) => reply,
    })
}

fn move_file(target: &Target, (source, destination, base): &(String, String, Option<String>)) -> Result<Reply, Failure> {
    let gh = GitHub::new(target);
    let outcome = gh.edit(&[source.as_str(), destination.as_str()], |found| match (&found[0], &found[1], base) {
        (Found::Entry { sha, kind, .. }, Found::Missing, None) if kind == "tree" => Ok((
            vec![
                json!({ "path": source, "mode": "040000", "type": "tree", "sha": Value::Null }),
                json!({ "path": destination, "mode": "040000", "type": "tree", "sha": sha }),
            ],
            format!("Rootlore: Move {source}/ → {destination}/"),
        )),
        (Found::Entry { sha, mode, kind }, Found::Missing, Some(base)) if kind == "blob" && sha == base => Ok((
            vec![
                json!({ "path": source, "mode": mode, "type": "blob", "sha": Value::Null }),
                json!({ "path": destination, "mode": mode, "type": "blob", "sha": sha }),
            ],
            format!("Rootlore: Move {source} → {destination}"),
        )),
        _ => Err((409, json!({ "error": "conflict" }))),
    })?;
    Ok(outcome.map(|_| (200, json!({ "moved": true }))).unwrap_or_else(|reply| reply))
}

fn delete_file(target: &Target, (path, base): &(String, String)) -> Result<Reply, Failure> {
    let gh = GitHub::new(target);
    let outcome = gh.edit(&[path.as_str()], |found| match &found[0] {
        Found::Entry { sha, mode, kind } if kind == "blob" && sha == base => Ok((
            vec![json!({ "path": path, "mode": mode, "type": "blob", "sha": Value::Null })],
            format!("Rootlore: Delete {path}"),
        )),
        _ => Err((409, json!({ "error": "conflict" }))),
    })?;
    Ok(outcome.map(|_| (200, json!({ "deleted": true }))).unwrap_or_else(|reply| reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn paths_follow_the_worker_rules() {
        assert!(writable_path("Notes/a.md"));
        assert!(writable_path(".claude/skills/my-skill/SKILL.md"));
        assert!(writable_path("Notes/一覧.base"));
        for bad in ["Notes/a.txt", "Library/Std/x.md", ".github/x.md", "a//b.md", "a\\b.md", "../x.md", ".claude/skills/Bad/SKILL.md", ".obsidian/x.base"] {
            assert!(!writable_path(bad), "{bad}");
        }
        assert!(editable_path("Notes/image.png"));
        assert!(!editable_path("Library/Std/x.md"));
        assert!(conflict_copy("Notes/a.conflicted-20261104-153000.md"));
        assert!(!conflict_copy("Notes/a.md"));
        assert!(skill_link_path(".agents/skills/my-skill"));
        assert!(skill_link_target(".agents/skills/my-skill", "../../.claude/skills/my-skill"));
        assert!(!skill_link_target(".agents/skills/my-skill", "../../.claude/skills/other"));
    }

    #[test]
    fn commit_requests_are_checked_like_the_worker() {
        let ok = json!({ "files": [{ "path": "a.md", "content": "aGk=", "baseSha": null }] });
        let parsed = parse_commit(&ok).unwrap();
        assert_eq!(parsed.files[0].base, None);
        let with_base = json!({ "files": [{ "path": "a.md", "content": "aGk=", "baseSha": SHA }], "deletions": [{ "path": "a.conflicted-1.md", "baseSha": SHA }] });
        assert!(parse_commit(&with_base).is_some());
        for bad in [
            json!({ "files": [] }),
            json!({ "files": [{ "path": "a.md", "content": "not base64!", "baseSha": null }] }),
            json!({ "files": [{ "path": ".github/x.md", "content": "aGk=", "baseSha": null }] }),
            json!({ "files": [{ "path": "a.md", "content": "aGk=", "baseSha": "short" }] }),
            json!({ "files": [{ "path": "a.md", "content": "aGk=", "baseSha": null }, { "path": "a.md", "content": "aGk=", "baseSha": null }] }),
            json!({ "files": [{ "path": "a.md", "content": "aGk=", "baseSha": null }], "deletions": [{ "path": "b.md", "baseSha": SHA }] }),
        ] {
            assert!(parse_commit(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn move_and_delete_requests_are_checked_like_the_worker() {
        assert!(parse_move(&json!({ "source": "a.md", "destination": "b/a.md", "baseSha": SHA })).is_some());
        assert_eq!(parse_move(&json!({ "source": "a", "destination": "b/a", "folder": true })).unwrap().2, None);
        assert!(parse_move(&json!({ "source": "a", "destination": "b/a" })).is_none());
        assert!(parse_move(&json!({ "source": "a", "destination": "a/b", "baseSha": SHA })).is_none());
        assert!(parse_move(&json!({ "source": "a.md", "destination": "Library/Std/a.md", "baseSha": SHA })).is_none());
        assert!(parse_delete(&json!({ "path": "Notes/a.md", "baseSha": SHA })).is_some());
        assert!(parse_delete(&json!({ "path": "../a.md", "baseSha": SHA })).is_none());
        assert!(parse_delete(&json!({ "path": "a.md", "baseSha": "x" })).is_none());
    }

    #[test]
    fn writes_for_another_repository_are_refused_before_github() {
        let target = Target { token: "t", owner: "me", repo: "notes", branch: "main" };
        let (status, body) = handle("/delete", br#"{"path":"a.md","baseSha":"0123456789abcdef0123456789abcdef01234567"}"#, Some("me/other"), &target);
        assert_eq!(status, 412);
        assert_eq!(body["error"], "repo");
        assert_eq!(handle("/delete", b"{}", Some("ME/notes"), &target).0, 400);
    }

    #[test]
    fn headlines_match_the_worker() {
        assert_eq!(headline(&["Notes/買い物メモ.md"]), "Rootlore: 買い物メモ");
        assert_eq!(headline(&["a.md", "b.md", "c.md"]), "Rootlore: a ほか2件");
    }
    /// 本物の GitHub で、保存 → 書き換え → 食い違い → 移動 → 削除 を通す。普段は動かさない。
    /// ROOTLORE_E2E_TOKEN と ROOTLORE_E2E_REPO（owner/repo。使い捨てのリポジトリ）を渡して cargo test -- --ignored
    #[test]
    #[ignore]
    fn writes_against_github() {
        let token = std::env::var("ROOTLORE_E2E_TOKEN").unwrap();
        let full = std::env::var("ROOTLORE_E2E_REPO").unwrap();
        let (owner, repo) = full.split_once('/').unwrap();
        let target = Target { token: &token, owner, repo, branch: "main" };
        let call = |rest: &str, body: Value| handle(rest, body.to_string().as_bytes(), Some(&full), &target);

        // 新しいノート（baseSha: null）
        let (status, created) = call("/commit", json!({ "files": [{ "path": "e2e/note.md", "content": "aGVsbG8=", "baseSha": null }] }));
        assert_eq!(status, 200, "{created}");
        let first = created["files"][0]["sha"].as_str().unwrap().to_string();
        // 同じ名前でもう一度作ろうとすると、上書きせずに食い違い
        let (status, again) = call("/commit", json!({ "files": [{ "path": "e2e/note.md", "content": "aGk=", "baseSha": null }] }));
        assert_eq!(status, 409, "{again}");
        assert_eq!(again["conflicts"][0]["sha"], first);
        // 読んだ版を添えて書き換える
        let (status, updated) = call("/commit", json!({ "files": [{ "path": "e2e/note.md", "content": "aGVsbG8gYWdhaW4=", "baseSha": first }] }));
        assert_eq!(status, 200, "{updated}");
        let second = updated["files"][0]["sha"].as_str().unwrap().to_string();
        // 古い版での移動・削除は止まる
        assert_eq!(call("/move", json!({ "source": "e2e/note.md", "destination": "e2e/moved.md", "baseSha": first })).0, 409);
        assert_eq!(call("/delete", json!({ "path": "e2e/note.md", "baseSha": first })).0, 409);
        // 今の版なら移動して、削除できる
        assert_eq!(call("/move", json!({ "source": "e2e/note.md", "destination": "e2e/moved.md", "baseSha": second })).0, 200);
        assert_eq!(call("/delete", json!({ "path": "e2e/moved.md", "baseSha": second })).0, 200);
        assert_eq!(call("/delete", json!({ "path": "e2e/moved.md", "baseSha": second })).0, 409);
        // フォルダの移動: 中のファイルごと1回で動く。行き先がふさがっていれば止まる
        assert_eq!(call("/commit", json!({ "files": [{ "path": "box/a.md", "content": "YQ==", "baseSha": null }, { "path": "box/sub/b.md", "content": "Yg==", "baseSha": null }] })).0, 200);
        assert_eq!(call("/move", json!({ "source": "box", "destination": "README.md", "folder": true })).0, 409);
        assert_eq!(call("/move", json!({ "source": "box", "destination": "e2e/box", "folder": true })).0, 200);
        assert_eq!(call("/commit", json!({ "files": [{ "path": "e2e/box/sub/b.md", "content": "Yg==", "baseSha": null }] })).0, 409);
        assert_eq!(call("/commit", json!({ "files": [{ "path": "box/a.md", "content": "YQ==", "baseSha": null }] })).0, 200);
    }
}
