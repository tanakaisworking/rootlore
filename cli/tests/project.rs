//! rootlore project を、手元の代わりの Worker に向けて、実際のコマンドで動かす（書き込みは write と同じ道を通る）。
#![cfg(unix)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

#[derive(Default)]
struct Vault {
    notes: BTreeMap<String, String>,
    /// 次の書き込みの直前に、ほかの人が変えた内容（場所、本文）
    before_commit: Option<(String, String)>,
    commits: usize,
}

fn sha(text: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0{text}", text.len()).as_bytes());
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn answer(vault: &mut Vault, url: &str, body: &str) -> (u16, String) {
    let by_sha = |v: &Vault, wanted: &str| v.notes.values().find(|t| sha(t) == wanted).cloned().unwrap_or_default();
    let path = url.split('?').next().unwrap();
    let value = match path {
        "/.config" => json!({ "githubRepo": { "owner": "acme", "repo": "vault", "branch": "main" } }),
        "/api/gh/repos/acme/vault/git/trees/main" => {
            let tree: Vec<Value> = vault.notes.iter().map(|(p, t)| json!({ "path": p, "type": "blob", "sha": sha(t) })).collect();
            json!({ "tree": tree })
        }
        "/api/gh/graphql" => {
            let request: Value = serde_json::from_str(body).unwrap();
            let blobs: serde_json::Map<String, Value> = request["shas"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    let text = by_sha(vault, s.as_str().unwrap());
                    (format!("b{i}"), json!({ "text": text, "byteSize": text.len() }))
                })
                .collect();
            json!({ "data": { "repository": blobs } })
        }
        "/api/gh/commit" => {
            if let Some((path, text)) = vault.before_commit.take() {
                vault.notes.insert(path, text);
            }
            let request: Value = serde_json::from_str(body).unwrap();
            let files = request["files"].as_array().unwrap();
            let conflicts: Vec<Value> = files
                .iter()
                .filter_map(|f| {
                    let path = f["path"].as_str().unwrap();
                    let current = vault.notes.get(path).map(|t| sha(t));
                    (current.as_deref() != f["baseSha"].as_str()).then(|| json!({ "path": path, "sha": current }))
                })
                .collect();
            if !conflicts.is_empty() {
                return (409, json!({ "conflicts": conflicts }).to_string());
            }
            let written: Vec<Value> = files
                .iter()
                .map(|f| {
                    let path = f["path"].as_str().unwrap().to_string();
                    let text = String::from_utf8(STANDARD.decode(f["content"].as_str().unwrap()).unwrap()).unwrap();
                    let entry = json!({ "path": path, "sha": sha(&text) });
                    vault.notes.insert(path, text);
                    entry
                })
                .collect();
            vault.commits += 1;
            json!({ "commit": "c0ffee", "files": written })
        }
        _ => match path.strip_prefix("/api/gh/repos/acme/vault/git/blobs/") {
            Some(wanted) => return (200, by_sha(vault, wanted)),
            None => return (404, "{}".into()),
        },
    };
    (200, value.to_string())
}

struct Cli {
    home: PathBuf,
    url: String,
    vault: Arc<Mutex<Vault>>,
}

impl Cli {
    fn start(test: &str, notes: &[(&str, &str)]) -> Cli {
        let vault = Arc::new(Mutex::new(Vault {
            notes: notes.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect(),
            ..Vault::default()
        }));
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr().to_ip().unwrap());
        let shared = vault.clone();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                let (status, text) = answer(&mut shared.lock().unwrap(), request.url(), &body);
                let _ = request.respond(tiny_http::Response::from_string(text).with_status_code(status));
            }
        });
        let home = std::env::temp_dir().join(format!("rootlore-cli-test-{}-{test}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        // dirs の設定の置き場所（macOS と Linux）
        for config in ["Library/Application Support/rootlore", ".config/rootlore"] {
            std::fs::create_dir_all(home.join(config)).unwrap();
            std::fs::write(home.join(config).join("session"), "test-session").unwrap();
        }
        Cli { home, url, vault }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rootlore"))
            .args(args)
            .env_clear()
            .env("HOME", &self.home)
            .env("ROOTLORE_URL", &self.url)
            .env("NO_PROXY", "*")
            .env("LANG", "en_US.UTF-8")
            .output()
            .unwrap()
    }

    fn ok(&self, args: &[&str]) -> String {
        let out = self.run(args);
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    fn json(&self, args: &[&str]) -> Value {
        serde_json::from_str(&self.ok(args)).unwrap()
    }

    fn fails(&self, args: &[&str], message: &str) {
        let out = self.run(args);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(!out.status.success() && stderr.contains(message), "{args:?}: {stderr}");
    }

    fn note(&self, path: &str) -> String {
        self.vault.lock().unwrap().notes[path].clone()
    }
}

impl Drop for Cli {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

#[test]
fn list_and_show_read_the_projects_folder_that_was_set_once() {
    let cli = Cli::start(
        "read",
        &[
            ("work/Alpha/index.md", "---\ntype: project\nrepos: [acme/app]\ndrive: https://drive.example.com/a\nsite: https://alpha.example.com\nrelease: tag and push\npeople: [Ann, Lee]\n---\n# Alpha\n"),
            ("work/Memo/index.md", "# memo\n"),
            ("Projects/Other/index.md", "---\ntype: project\nrepos: [acme/other]\n---\n"),
        ],
    );
    let found = cli.json(&["project", "list", "--json"]);
    assert_eq!((found["dir"].as_str(), found["projects"][0]["name"].as_str()), (Some("Projects"), Some("Other")));
    cli.ok(&["project", "dir", "work/"]);
    assert_eq!(cli.ok(&["project", "dir"]), "work\n");
    assert_eq!(cli.ok(&["project", "list"]), "Alpha\tacme/app\thttps://alpha.example.com\n");
    // 今回だけのフォルダは、覚えた設定より優先する
    assert_eq!(cli.ok(&["project", "list", "--projects-dir", "Projects"]), "Other\tacme/other\t\n");

    let shown = cli.ok(&["project", "show", "Alpha"]);
    for line in ["Repository: https://github.com/acme/app", "Drive: https://drive.example.com/a", "Site: https://alpha.example.com", "Release process: tag and push", "People: Ann, Lee"] {
        assert!(shown.contains(line), "{shown}");
    }
    let shown = cli.json(&["project", "show", "Alpha", "--json"]);
    assert_eq!(shown["people"], json!(["Ann", "Lee"]));
    assert_eq!(shown["repos"], json!([{ "repo": "acme/app", "url": "https://github.com/acme/app" }]));
    cli.fails(&["project", "show", "Memo"], "Not a note with `type: project`");
    cli.fails(&["project", "show", "Nope"], "Project not found");
}

#[test]
fn new_creates_the_note_once() {
    let cli = Cli::start("new", &[("Projects/Taken/index.md", "mine\n")]);
    let done = cli.json(&["project", "new", "Alpha", "--repo", "acme/app", "--drive", "https://drive.example.com/a", "--json"]);
    assert_eq!(done["status"], "committed");
    let text = cli.note("Projects/Alpha/index.md");
    assert!(text.starts_with("---\ntype: project\nrepos:\n  - acme/app\ndrive: https://drive.example.com/a\n---\n\n# Alpha\n\n## Overview\n"), "{text}");
    cli.fails(&["project", "new", "Alpha"], "Already exists");
    cli.fails(&["project", "new", "Taken"], "Already exists");
    cli.fails(&["project", "new", "alpha"], "大文字小文字");
    cli.fails(&["project", "new", "a/b"], "This name cannot be used");
    cli.fails(&["project", "new", "B", "--repo", "not-a-repo"], "owner/repo");
    // 送る直前に、ほかの人が同じノートを作った。まとめも写しも作らずに断る
    cli.vault.lock().unwrap().before_commit = Some(("Projects/Race/index.md".into(), "theirs\n".into()));
    cli.fails(&["project", "new", "Race"], "Already exists");
    let vault = cli.vault.lock().unwrap();
    assert_eq!(vault.notes["Projects/Race/index.md"], "theirs\n");
    assert_eq!(vault.notes["Projects/Taken/index.md"], "mine\n");
    assert_eq!((vault.commits, vault.notes.len()), (1, 3));
}

#[test]
fn link_edits_only_the_front_matter_and_merges_with_newer_changes() {
    let path = "Projects/Alpha/index.md";
    let body = "\n# Alpha\n\n## Overview\n\nfirst\n\n## Decisions\n  trailing  \nno newline";
    let start = format!("---\ntype: project\n---\n{body}");
    let cli = Cli::start("link", &[(path, &start)]);

    cli.ok(&["project", "link", "Alpha", "--repo", "acme/app", "--site", "https://alpha.example.com"]);
    let linked = format!("---\ntype: project\nrepos:\n  - acme/app\nsite: https://alpha.example.com\n---\n{body}");
    assert_eq!(cli.note(path), linked);
    assert_eq!(cli.json(&["project", "link", "Alpha", "--repo", "acme/app", "--json"])["status"], "unchanged");
    assert_eq!(cli.vault.lock().unwrap().commits, 1);

    // 送る直前に本文が変わった。write と同じく、3方向でまとめて両方残す
    cli.vault.lock().unwrap().before_commit = Some((path.into(), format!("{linked}\nadded by someone else\n")));
    let done = cli.json(&["project", "link", "Alpha", "--drive", "https://drive.example.com/a", "--json"]);
    assert_eq!(done["status"], "merged");
    let merged = cli.note(path);
    assert!(merged.contains("drive: https://drive.example.com/a\n---\n") && merged.ends_with("no newline\nadded by someone else\n"), "{merged}");

    // 同じ行がぶつかった。ノートはそのままで、まとめの写しを残して終了コード 3
    let theirs = merged.replace("site: https://alpha.example.com", "site: https://theirs.example.com");
    cli.vault.lock().unwrap().before_commit = Some((path.into(), theirs.clone()));
    let out = cli.run(&["project", "link", "Alpha", "--site", "https://mine.example.com", "--json"]);
    assert_eq!(out.status.code(), Some(3), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(cli.note(path), theirs);
    let done: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(cli.note(done["conflictCopy"].as_str().unwrap()).contains("https://mine.example.com"));

    cli.fails(&["project", "link", "Alpha"], "Give --repo, --site or --drive");
    cli.fails(&["project", "link", "Nope", "--repo", "a/b"], "Project not found");
}
