//! rootlore project: プロジェクトの台帳。「<プロジェクトのフォルダ>/<名前>/index.md」で、front matter が
//! type: project のノートが1つのプロジェクト。ノートに置くのは変わりにくいことだけ（repos・site・drive・release・people）。
//! Rootlore が読めるのは Vault のリポジトリ1つだけなので、ここに挙げたリポジトリは読みに行かず、リンクとして出す。
//! 開いている PR などの今の状態は扱わない（ノートにも書かない）。

use std::fs;

use serde_json::{json, Value};

use crate::frontmatter::{quote, FrontMatter};
use crate::{Done, Options, Result, Sent, Store};

const DEFAULT_DIR: &str = "Projects";
/// 新しいプロジェクトのノートの見出し（ひな形はここと template だけに置く）
const HEADINGS: [&str; 4] = ["Overview", "Audience", "Where things live", "Decisions"];

/// 日本語の環境なら日本語、それ以外と分からないときは英語
fn t<'a>(ja: &'a str, en: &'a str) -> &'a str {
    let lang = ["LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()));
    if lang.is_some_and(|l| l.starts_with("ja")) {
        ja
    } else {
        en
    }
}

const HELP_JA: &str = "rootlore project — プロジェクトの台帳（<フォルダ>/<名前>/index.md、front matter が type: project）

  rootlore project list                  プロジェクトの一覧（名前、リポジトリ、サイト）
  rootlore project show <名前>           ノートの内容と、リポジトリ・サイト・Drive のリンク
  rootlore project new <名前> [--repo owner/repo]… [--site URL] [--drive URL]
  rootlore project link <名前> [--repo owner/repo]… [--site URL] [--drive URL]
  rootlore project dir [フォルダ]        プロジェクトのフォルダを見る・決める（一度決めれば覚える。標準は Projects）

オプション: --json、--no-pull（list・show）、--message M（new・link）、--projects-dir P（今回だけのフォルダ）
挙げたリポジトリの中身は読みません（Rootlore が読めるのは Vault のリポジトリだけです）。
";

const HELP_EN: &str = "rootlore project — the project registry (<dir>/<name>/index.md with `type: project` in its front matter)

  rootlore project list                  every project (name, repositories, site)
  rootlore project show <name>           the note's details, with links to its repositories, site and Drive
  rootlore project new <name> [--repo owner/repo]... [--site URL] [--drive URL]
  rootlore project link <name> [--repo owner/repo]... [--site URL] [--drive URL]
  rootlore project dir [folder]          show or set the projects folder (remembered; default: Projects)

Options: --json, --no-pull (list, show), --message M (new, link), --projects-dir P (this run only)
The listed repositories are not read: Rootlore can only access the repository that holds your vault.
";

// --- 引数と置き場所 ---

#[derive(Default)]
struct Links {
    repos: Vec<String>,
    site: Option<String>,
    drive: Option<String>,
}

impl Links {
    fn is_empty(&self) -> bool {
        self.repos.is_empty() && self.site.is_none() && self.drive.is_none()
    }
}

struct Args {
    options: Options,
    links: Links,
    dir: Option<String>,
}

fn parse_args(args: &[String]) -> Result<Args> {
    let (mut links, mut dir, mut rest) = (Links::default(), None, vec![]);
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = || {
            iter.next()
                .filter(|v| !v.starts_with("--"))
                .cloned()
                .ok_or_else(|| format!("{arg} {}", t("には値を付けてください", "needs a value")))
        };
        match arg.as_str() {
            "--repo" => {
                let repo = value()?;
                if !is_repo(&repo) {
                    return Err(format!("{}: {repo}", t("--repo は owner/repo の形で指定してください", "--repo must look like owner/repo")));
                }
                if !links.repos.iter().any(|r| r.eq_ignore_ascii_case(&repo)) {
                    links.repos.push(repo);
                }
            }
            "--site" => links.site = Some(url(value()?)?),
            "--drive" => links.drive = Some(url(value()?)?),
            "--projects-dir" => dir = Some(clean_dir(&value()?)?),
            _ => rest.push(arg.clone()),
        }
    }
    let options = crate::parse_options(&rest)?;
    if let Some(unknown) = options.words.iter().find(|w| w.starts_with('-')) {
        return Err(format!("{}: {unknown}", t("知らないオプションです", "Unknown option")));
    }
    if options.base.is_some() {
        return Err(t("project では --base は使えません", "--base is not used with project commands").into());
    }
    Ok(Args { options, links, dir })
}

/// GitHub の「owner/repo」
fn is_repo(text: &str) -> bool {
    let part = |s: &str| !s.is_empty() && s != "." && s != ".." && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
    text.split_once('/').is_some_and(|(owner, repo)| part(owner) && part(repo))
}

fn url(value: String) -> Result<String> {
    let ok = (value.starts_with("https://") || value.starts_with("http://")) && !value.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then_some(value.clone())
        .ok_or_else(|| format!("{}: {value}", t("URL は http:// か https:// で始めてください", "URLs must start with http:// or https://")))
}

fn clean_dir(dir: &str) -> Result<String> {
    let dir = dir.trim_end_matches('/');
    crate::is_note(&format!("{dir}/x/index.md"))
        .then(|| dir.to_string())
        .ok_or_else(|| format!("{}: {dir}", t("Vault の中のフォルダを指定してください", "Give a folder inside the vault")))
}

fn dir_setting() -> Result<std::path::PathBuf> {
    Ok(crate::config_dir()?.join("projects-dir"))
}

/// --projects-dir、覚えている設定、標準の順
fn projects_dir(flag: Option<&str>) -> Result<String> {
    if let Some(dir) = flag {
        return Ok(dir.to_string());
    }
    match fs::read_to_string(dir_setting()?) {
        Ok(saved) => clean_dir(saved.trim()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DEFAULT_DIR.into()),
        Err(e) => Err(e.to_string()),
    }
}

fn note_path(dir: &str, name: &str) -> Result<String> {
    let path = format!("{dir}/{name}/index.md");
    let ok = !name.contains('/') && name.trim() == name && !name.chars().any(char::is_control) && crate::is_note(&path);
    ok.then_some(path).ok_or_else(|| format!("{}: {name}", t("この名前は使えません", "This name cannot be used")))
}

// --- 読む ---

#[derive(Debug)]
struct Project {
    name: String,
    path: String,
    repos: Vec<String>,
    drive: Option<String>,
    site: Option<String>,
    release: Option<String>,
    people: Vec<String>,
}

/// リポジトリの GitHub のページ。ノートの中身は信用しないので、owner/repo の形でなければリンクにしない
fn repo_url(repo: &str) -> Option<String> {
    is_repo(repo).then(|| format!("https://github.com/{repo}"))
}

impl Project {
    fn json(&self) -> Value {
        let repos: Vec<Value> = self.repos.iter().map(|r| json!({ "repo": r, "url": repo_url(r) })).collect();
        json!({
            "name": self.name, "path": self.path, "repos": repos, "site": self.site,
            "drive": self.drive, "release": self.release, "people": self.people,
        })
    }
}

fn parse_project(name: &str, path: &str, text: &str) -> Option<Project> {
    let fm = FrontMatter::parse(text)?;
    (fm.text("type") == Some("project")).then(|| Project {
        name: name.into(),
        path: path.into(),
        repos: fm.list("repos"),
        drive: fm.text("drive").map(Into::into),
        site: fm.text("site").map(Into::into),
        release: fm.text("release").map(Into::into),
        people: fm.list("people"),
    })
}

/// 手元の写しから、プロジェクトのノートを全部読む（名前の順）
fn load_projects(store: &Store, dir: &str) -> Vec<Project> {
    let prefix = format!("{dir}/");
    store
        .state
        .files
        .keys()
        .filter_map(|path| {
            let name = path.strip_prefix(&prefix)?.strip_suffix("/index.md").filter(|n| !n.contains('/'))?;
            parse_project(name, path, &fs::read_to_string(store.notes_dir().join(path)).ok()?)
        })
        .collect()
}

/// ノートの文字を端末に出す前に、制御文字（端末を操作できる）を空白にする
fn plain(text: &str) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

fn list(args: &Args) -> Result<()> {
    let dir = projects_dir(args.dir.as_deref())?;
    let store = crate::fresh_store(args.options.no_pull)?;
    let projects = load_projects(&store, &dir);
    if args.options.json {
        let items: Vec<Value> = projects.iter().map(Project::json).collect();
        println!("{}", json!({ "total": items.len(), "dir": dir, "projects": items }));
        return Ok(());
    }
    for p in &projects {
        println!("{}\t{}\t{}", plain(&p.name), plain(&p.repos.join(", ")), plain(p.site.as_deref().unwrap_or("")));
    }
    if projects.is_empty() {
        eprintln!(
            "{dir}/ {}",
            t(
                "にプロジェクトはありません（rootlore project dir <フォルダ> でフォルダを変えられます）",
                "has no projects (change the folder with `rootlore project dir <folder>`)"
            )
        );
    }
    Ok(())
}

fn name_arg(args: &Args) -> Result<&str> {
    match args.options.words.as_slice() {
        [name] => Ok(name),
        _ => Err(t("プロジェクトの名前を1つ付けてください（rootlore project help）", "Give one project name (rootlore project help)").into()),
    }
}

fn not_a_project(path: &str) -> String {
    format!("{}: {path}", t("type: project のノートではありません", "Not a note with `type: project`"))
}

fn missing(path: &str) -> String {
    format!("{}: {path}", t("プロジェクトが見つかりません", "Project not found"))
}

/// show の text 出力。ないものの行は出さない
fn describe(project: &Project) -> String {
    let mut out = format!("{}\n{}: {}\n", plain(&project.name), t("ノート", "Note"), plain(&project.path));
    for repo in &project.repos {
        let link = repo_url(repo).unwrap_or_else(|| repo.clone());
        out.push_str(&format!("{}: {}\n", t("リポジトリ", "Repository"), plain(&link)));
    }
    let people = project.people.join(", ");
    for (label, value) in [
        (t("サイト", "Site"), project.site.as_deref()),
        ("Drive", project.drive.as_deref()),
        (t("出し方", "Release process"), project.release.as_deref()),
        (t("人", "People"), (!people.is_empty()).then_some(people.as_str())),
    ] {
        if let Some(value) = value {
            out.push_str(&format!("{label}: {}\n", plain(value)));
        }
    }
    out
}

fn show(args: &Args) -> Result<()> {
    let name = name_arg(args)?;
    let path = note_path(&projects_dir(args.dir.as_deref())?, name)?;
    let store = crate::fresh_store(args.options.no_pull)?;
    if !store.state.files.contains_key(&path) {
        return Err(missing(&path));
    }
    let text = fs::read_to_string(store.notes_dir().join(&path)).map_err(|e| format!("{path}: {e}"))?;
    let project = parse_project(name, &path, &text).ok_or_else(|| not_a_project(&path))?;
    if args.options.json {
        println!("{}", project.json());
    } else {
        print!("{}", describe(&project));
    }
    Ok(())
}

// --- 書く ---

fn template(name: &str, links: &Links) -> String {
    let mut out = String::from("---\ntype: project\n");
    if !links.repos.is_empty() {
        out.push_str("repos:\n");
        for repo in &links.repos {
            out.push_str(&format!("  - {}\n", quote(repo)));
        }
    }
    for (key, value) in [("site", &links.site), ("drive", &links.drive)] {
        if let Some(value) = value {
            out.push_str(&format!("{key}: {}\n", quote(value)));
        }
    }
    out.push_str(&format!("---\n\n# {name}\n"));
    for heading in HEADINGS {
        out.push_str(&format!("\n## {heading}\n"));
    }
    out
}

/// front matter に足す。もう全部入っていれば None。本文は変えない
fn add_links(path: &str, text: &str, links: &Links) -> Result<Option<String>> {
    if parse_project("", path, text).is_none() {
        return Err(not_a_project(path));
    }
    let unsupported = |key: &str| {
        format!(
            "{} ({key}): {path}",
            t("この書き方の front matter は自動で直せません。ノートを直接直してください", "This front matter cannot be edited automatically; edit the note by hand")
        )
    };
    let mut out = text.to_string();
    for repo in &links.repos {
        let fm = FrontMatter::parse(&out).ok_or_else(|| unsupported("repos"))?;
        if !fm.list("repos").iter().any(|r| r.eq_ignore_ascii_case(repo)) {
            out = fm.push_item("repos", repo).map_err(|()| unsupported("repos"))?;
        }
    }
    for (key, value) in [("site", &links.site), ("drive", &links.drive)] {
        let Some(value) = value else { continue };
        let fm = FrontMatter::parse(&out).ok_or_else(|| unsupported(key))?;
        if fm.text(key) != Some(value) {
            out = fm.set_text(key, value).map_err(|()| unsupported(key))?;
        }
    }
    Ok((out != text).then_some(out))
}

/// 新しいノートを送る。write と違い、先に同じノートができていたら、まとめずに断る
fn create(args: &Args) -> Result<Done> {
    let name = name_arg(args)?;
    let path = note_path(&projects_dir(args.dir.as_deref())?, name)?;
    let exists = || format!("{}: {path}", t("もうあります", "Already exists"));
    let mut api = crate::Api::new()?;
    let store = crate::pull(&mut api)?;
    if store.state.files.contains_key(&path) {
        return Err(exists());
    }
    crate::check_writable(&store, &path)?;
    let text = template(name, &args.links);
    let (sha, commit) = match crate::send(&mut api, &[(&path, &text, None)], &[], args.options.message.as_deref()) {
        Ok(Sent::Committed { commit, shas }) => {
            let sha = shas.get(&path).cloned().ok_or_else(|| t("書き込みの返事に版がありません", "The reply has no version").to_string())?;
            crate::refresh_copy(&[(&path, &text, &sha)], &[]);
            (sha, Some(commit))
        }
        Ok(Sent::Conflict(_)) => return Err(exists()),
        Err(e) if e.starts_with(crate::SENT_UNKNOWN) => (crate::confirm_after_unknown(&mut api, &path, &text, e)?, None),
        Err(e) => return Err(e),
    };
    Ok(Done { output: json!({ "status": "committed", "path": path, "sha": sha, "commit": commit }), conflict: false })
}

/// 最新を取り込んで front matter に足し、write と同じ道（読んだときの版を添え、先に変わっていれば3方向でまとめる）で送る
fn link(args: &Args) -> Result<Done> {
    let name = name_arg(args)?;
    if args.links.is_empty() {
        return Err(t("--repo、--site、--drive のどれかを付けてください", "Give --repo, --site or --drive").into());
    }
    let path = note_path(&projects_dir(args.dir.as_deref())?, name)?;
    let mut api = crate::Api::new()?;
    let store = crate::pull(&mut api)?;
    if !store.state.files.contains_key(&path) {
        return Err(missing(&path));
    }
    let data = fs::read(store.notes_dir().join(&path)).map_err(|e| format!("{path}: {e}"))?;
    let sha = crate::git_blob_sha(&data);
    let text = String::from_utf8(data).map_err(|_| format!("{}: {path}", t("UTF-8 ではありません", "Not UTF-8")))?;
    let Some(new) = add_links(&path, &text, &args.links)? else {
        return Ok(Done { output: json!({ "status": "unchanged", "path": path, "sha": sha, "commit": null }), conflict: false });
    };
    let options = Options { base: Some(Some(sha)), message: args.options.message.clone(), ..crate::parse_options(&[])? };
    crate::write_inner(&options, false, &path, &new)
}

fn finish(done: Done, json_out: bool) {
    if !json_out && done.output["status"] == "unchanged" {
        println!("{}: {}", t("もう入っているので、変えていません", "Already linked; nothing changed"), done.output["path"].as_str().unwrap_or(""));
    } else {
        crate::print_done(&done, json_out);
    }
    if done.conflict {
        std::process::exit(crate::EXIT_CONFLICT as i32);
    }
}

fn set_dir(args: &Args) -> Result<()> {
    match args.options.words.as_slice() {
        [] => println!("{}", projects_dir(args.dir.as_deref())?),
        [dir] => {
            let dir = clean_dir(dir)?;
            crate::write_private(&dir_setting()?, dir.as_bytes())?;
            println!("{}: {dir}", t("プロジェクトのフォルダを決めました", "Projects folder set"));
        }
        _ => return Err(t("フォルダは1つだけ指定してください", "Give a single folder").into()),
    }
    Ok(())
}

pub fn run(args: &[String]) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("help");
    let parsed = parse_args(&args[args.len().min(1)..])?;
    if !parsed.links.is_empty() && !matches!(command, "new" | "link") {
        return Err(t("--repo、--site、--drive は new と link で使います", "--repo, --site and --drive are for `new` and `link`").into());
    }
    match command {
        "list" => list(&parsed),
        "show" => show(&parsed),
        "new" => create(&parsed).map(|done| finish(done, parsed.options.json)),
        "link" => link(&parsed).map(|done| finish(done, parsed.options.json)),
        "dir" => set_dir(&parsed),
        "help" | "--help" | "-h" => {
            print!("{}", t(HELP_JA, HELP_EN));
            Ok(())
        }
        other => Err(format!("{}: project {other} (rootlore project help)", t("知らないコマンドです", "Unknown command"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(repos: &[&str], site: Option<&str>, drive: Option<&str>) -> Links {
        Links { repos: repos.iter().map(|r| r.to_string()).collect(), site: site.map(Into::into), drive: drive.map(Into::into) }
    }

    fn fixture(notes: &[(&str, &str)]) -> Store {
        let dir = std::env::temp_dir().join(format!("rootlore-project-test-{}", crate::random_hex(8)));
        let mut store = Store { dir, state: Default::default() };
        for (path, text) in notes {
            crate::write_atomic(&store.notes_dir().join(path), text.as_bytes()).unwrap();
            store.state.files.insert(path.to_string(), crate::git_blob_sha(text.as_bytes()));
        }
        store
    }

    #[test]
    fn lists_only_project_notes_directly_under_the_folder() {
        let project = "---\ntype: project\nrepos: [acme/app]\nsite: https://example.com\n---\n";
        let store = fixture(&[
            ("Projects/Beta/index.md", "---\ntype: project\n---\n"),
            ("Projects/Alpha/index.md", project),
            ("Projects/Alpha/notes.md", project),
            ("Projects/Alpha/sub/index.md", project),
            ("Projects/Note/index.md", "---\ntype: note\n---\n"),
            ("Projects/Plain/index.md", "# plain\n"),
            ("Projects/index.md", project),
            ("Archive/Old/index.md", project),
            ("Areas/work/Gamma/index.md", project),
        ]);
        let found = load_projects(&store, "Projects");
        assert_eq!(found.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Alpha", "Beta"]);
        assert_eq!(found[0].repos, ["acme/app"]);
        assert_eq!(found[0].json()["repos"], json!([{ "repo": "acme/app", "url": "https://github.com/acme/app" }]));
        assert_eq!(found[0].site.as_deref(), Some("https://example.com"));
        assert_eq!(found[0].json()["path"], "Projects/Alpha/index.md");
        assert_eq!(load_projects(&store, "Areas/work")[0].name, "Gamma");
        fs::remove_dir_all(&store.dir).unwrap();
    }

    #[test]
    fn a_new_note_is_a_project_with_the_template_headings() {
        let text = template("Alpha", &links(&["acme/app"], Some("https://example.com"), None));
        assert_eq!(
            text,
            "---\ntype: project\nrepos:\n  - acme/app\nsite: https://example.com\n---\n\n# Alpha\n\n## Overview\n\n## Audience\n\n## Where things live\n\n## Decisions\n"
        );
        let project = parse_project("Alpha", "p", &text).unwrap();
        assert_eq!(project.repos, ["acme/app"]);
    }

    #[test]
    fn linking_keeps_the_body_byte_for_byte() {
        let body = "\r\n# Alpha\n\n  keep  \n---\nsite: in the body\nno newline at the end";
        let text = format!("---\ntype: project\nrepos:\n  - acme/app\ncustom: kept # note\n---\n{body}");
        let new = add_links("p", &text, &links(&["acme/web", "ACME/App"], Some("https://example.com"), Some("https://drive.example.com/x"))).unwrap().unwrap();
        assert_eq!(
            new,
            format!("---\ntype: project\nrepos:\n  - acme/app\n  - acme/web\ncustom: kept # note\nsite: https://example.com\ndrive: https://drive.example.com/x\n---\n{body}")
        );
        // もう入っているものだけなら、何も変えない
        assert!(add_links("p", &new, &links(&["acme/web"], Some("https://example.com"), None)).unwrap().is_none());
        assert!(add_links("p", "---\ntype: note\n---\n", &links(&["a/b"], None, None)).is_err());
    }

    #[test]
    fn names_repos_and_folders_cannot_escape() {
        for bad in ["a", "a/b/c", "../b", "a/..", "a/b?x=1", "a/b#", "a b/c", "/b", "a/"] {
            assert!(!is_repo(bad), "{bad}");
        }
        assert!(is_repo("Acme-1/app.rs_x"));
        for bad in ["", "a/b", "..", ".hidden", " x", "a\\b", "a:b", "a\nb"] {
            assert!(note_path("Projects", bad).is_err(), "{bad:?}");
        }
        assert_eq!(note_path("2_Areas", "Alpha").unwrap(), "2_Areas/Alpha/index.md");
        assert_eq!(clean_dir("work/projects/").unwrap(), "work/projects");
        for bad in ["", "/abs", "../x", "a//b", ".hidden"] {
            assert!(clean_dir(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn only_owner_repo_values_become_links() {
        assert_eq!(repo_url("acme/app").as_deref(), Some("https://github.com/acme/app"));
        assert_eq!(repo_url("javascript:alert(1)"), None);
        assert_eq!(repo_url("acme/app/../../x"), None);
    }
}
