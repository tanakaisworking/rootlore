//! ノートを開くリンクの解釈: rootlore://open?repo=<owner/name>&page=<ノートの場所（.md 付き）>
//! 作る側は CLI の rootlore link（cli/src/main.rs の page_links）。形を変えるときは両方を直す。
//!
//! rootlore:// はどの Web ページやアプリからでも呼べるので、このリンクでできるのは
//! 「接続中のリポジトリのノートを、同梱した画面で開く」だけにする。ここでは解釈と検証だけを行い、
//! 何も読み書きしない（開く処理は main.rs の open_page_link）。
use tauri::Url;

/// 開くノート。repo は "owner/name"、path は Vault の中の場所（例: 2_Areas/会社/メモ.md）
#[derive(Debug, PartialEq, Eq)]
pub struct PageLink {
    pub repo: String,
    pub path: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    /// ノートを開くリンクではない（ログインの戻りの rootlore://auth など）。ここでは何もしない
    Other,
    /// ノートを開くリンクだが、中身を受け付けない
    Invalid,
    Page(PageLink),
}

pub fn parse(url: &Url) -> Parsed {
    if url.scheme() != "rootlore" || url.host_str() != Some("open") {
        return Parsed::Other;
    }
    let (mut repo, mut path) = (None, None);
    for (key, value) in url.query_pairs() {
        let slot = match key.as_ref() {
            "repo" => &mut repo,
            "page" => &mut path,
            _ => continue,
        };
        // 同じ項目が2つあるリンクは、どちらを開くかを決めずに断る
        if slot.replace(value.into_owned()).is_some() {
            return Parsed::Invalid;
        }
    }
    match (repo, path) {
        (Some(repo), Some(path)) if valid_repo(&repo) && valid_path(&path) => Parsed::Page(PageLink { repo, path }),
        _ => Parsed::Invalid,
    }
}

/// GitHub の owner/name の形（画面の案内に出し、接続中のリポジトリと比べる）
fn valid_repo(repo: &str) -> bool {
    let part = |s: &str| !s.is_empty() && s.len() <= 100 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    matches!(repo.split_once('/'), Some((owner, name)) if part(owner) && part(name))
}

/// 画面が「そのノート1つ」として開ける場所だけを通す。
/// 画面は URL の名前を silverbullet/plug-api/lib/ref.ts の決まりで読むので、それに合わない名前
/// （# や @ で見出しや位置の指定になる、末尾が拡張子に見えて別のファイルを指す、など）は、
/// 別のページを開いてしまう前にここで断る。同梱のページ（Library/Std/）と隠しフォルダも開かない
fn valid_path(path: &str) -> bool {
    let Some(name) = path.strip_suffix(".md") else { return false };
    let looks_like_file = name.rsplit_once('.').is_some_and(|(_, ext)| !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphanumeric()));
    path.len() <= 1024
        && !path.starts_with("Library/Std/")
        && !name.starts_with('^')
        && !name.contains(|c: char| c.is_control() || "@#$|<>\\".contains(c))
        && !name.contains("[[")
        && !name.contains("]]")
        && name.split('/').all(|part| !part.is_empty() && !part.starts_with('.'))
        && !looks_like_file
}

/// 接続中のリポジトリのノートか（GitHub は大文字小文字を区別しない）。未接続なら false
pub fn same_repo(link: &PageLink, connected: Option<&str>) -> bool {
    connected.is_some_and(|c| c.eq_ignore_ascii_case(&link.repo))
}

/// 同梱した画面でそのノートを開く URL（<origin>/v/<.md を取った場所>）。
/// 区切りごとに % で包むので、名前の中の ? や % が URL の別の部分にならない
pub fn local_url(origin: &str, link: &PageLink) -> Url {
    let mut url: Url = format!("{origin}/v/").parse().expect("local origin");
    let name = link.path.strip_suffix(".md").unwrap_or(&link.path);
    url.path_segments_mut().expect("http url").pop_if_empty().extend(name.split('/'));
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(url: &str) -> Parsed {
        parse(&url.parse().unwrap())
    }

    fn page(repo: &str, path: &str) -> Parsed {
        Parsed::Page(PageLink { repo: repo.into(), path: path.into() })
    }

    #[test]
    fn reads_the_link_the_cli_prints() {
        // cli/src/main.rs の page_links のテストと同じリンク
        assert_eq!(
            parsed("rootlore://open?repo=me/notes&page=2_Areas/%E4%BC%9A%E7%A4%BE/%E4%BA%8B%E6%A5%AD%20%E8%A8%88%E7%94%BB%3F.md"),
            page("me/notes", "2_Areas/会社/事業 計画?.md")
        );
    }

    #[test]
    fn reads_plain_and_fully_encoded_links() {
        assert_eq!(parsed("rootlore://open?repo=me/notes&page=INDEX.md"), page("me/notes", "INDEX.md"));
        assert_eq!(parsed("rootlore://open/?page=a%2Fb.md&repo=Me%2Fmy.notes-2"), page("Me/my.notes-2", "a/b.md"));
        // 貼り付けた日本語がそのまま届いても読める。知らない項目は無視する
        assert_eq!(parsed("rootlore://open?repo=me/notes&page=日記/今日.md&from=chat"), page("me/notes", "日記/今日.md"));
    }

    #[test]
    fn leaves_sign_in_and_unknown_links_alone() {
        for url in ["rootlore://auth?code=abc&state=def", "rootlore://auth?repo=me/notes&page=INDEX.md", "rootlore://other?page=INDEX.md", "https://open/?repo=me/notes&page=INDEX.md"] {
            assert_eq!(parsed(url), Parsed::Other, "{url}");
        }
    }

    #[test]
    fn refuses_links_that_are_not_one_note_in_one_repository() {
        let bad_pages = [
            "",
            "INDEX",
            "notes.txt",
            ".md",
            "/etc/passwd.md",
            "../secret.md",
            "a/../b.md",
            "a/./b.md",
            "a//b.md",
            ".obsidian/x.md",
            "a/.hidden.md",
            "Library/Std/Rootlore/Home.md",
            "^Library/Std/Config.md",
            "a#heading.md",
            "a@12.md",
            "a$anchor.md",
            "a|b.md",
            "a<b>.md",
            "[[a]].md",
            "a\\b.md",
            "a%0Ab.md",
            "a%00b.md",
            "photo.png.md",
            "https://example.com/x.md",
        ];
        for page in bad_pages {
            let url = format!("rootlore://open?repo=me/notes&page={}", page.replace('#', "%23"));
            assert_eq!(parsed(&url), Parsed::Invalid, "{page}");
        }
        assert_eq!(parsed(&format!("rootlore://open?repo=me/notes&page={}.md", "a".repeat(1100))), Parsed::Invalid);
        for repo in ["", "notes", "me/", "/notes", "me/notes/extra", "me/no tes", "me/notes%0A", "me/<b>"] {
            assert_eq!(parsed(&format!("rootlore://open?repo={repo}&page=INDEX.md")), Parsed::Invalid, "{repo}");
        }
        for url in [
            "rootlore://open",
            "rootlore://open?page=INDEX.md",
            "rootlore://open?repo=me/notes",
            "rootlore://open?repo=me/notes&page=INDEX.md&page=Other.md",
            "rootlore://open?repo=me/notes&repo=you/notes&page=INDEX.md",
            "rootlore://open?repo=me/notes&url=https://example.com",
        ] {
            assert_eq!(parsed(url), Parsed::Invalid, "{url}");
        }
    }

    #[test]
    fn opens_only_in_the_connected_repository() {
        let link = PageLink { repo: "Me/Notes".into(), path: "INDEX.md".into() };
        assert!(same_repo(&link, Some("me/notes")));
        assert!(!same_repo(&link, Some("me/other-notes")));
        assert!(!same_repo(&link, Some("you/notes")));
        assert!(!same_repo(&link, None));
    }

    #[test]
    fn the_page_url_stays_under_the_bundled_screen() {
        let url = |path: &str| local_url("http://127.0.0.1:37420", &PageLink { repo: "me/notes".into(), path: path.into() }).to_string();
        assert_eq!(url("INDEX.md"), "http://127.0.0.1:37420/v/INDEX");
        assert_eq!(url("2_Areas/会社/事業の因数分解.md"), "http://127.0.0.1:37420/v/2_Areas/%E4%BC%9A%E7%A4%BE/%E4%BA%8B%E6%A5%AD%E3%81%AE%E5%9B%A0%E6%95%B0%E5%88%86%E8%A7%A3");
        // 名前の中の ? や % や空白は、名前のまま（クエリや別の % 表記にならない）
        assert_eq!(url("日記/100% 本当?.md"), "http://127.0.0.1:37420/v/%E6%97%A5%E8%A8%98/100%25%20%E6%9C%AC%E5%BD%93%3F");
    }
}

