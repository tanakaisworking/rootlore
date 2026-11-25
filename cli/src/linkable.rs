//! リンクで開けるノートの場所の決まり。CLI（rootlore link）と Mac アプリ（desktop/src-tauri/src/page_link.rs が
//! #[path] でこのファイルを取り込む）が同じものを使うので、std だけで書く。
//!
//! 画面は URL の /v/<名前> を silverbullet/plug-api/lib/ref.ts の決まりで読む。その読み方で「このノート1つ」にならない名前は、
//! リンクにすると別のページが開くので、ここで断る。例は linkable_cases.txt にあり、画面の側のテスト
//! （silverbullet/client/vault_web_page_link.test.ts）も同じ例で、通した名前がそのノートとして読まれることを確かめる。

/// アプリ自身が /v/ の下で使う場所（API の口と同梱ファイル。worker/index.ts、desktop/src-tauri/src/local.rs）。
/// 同じ名前で始まるノートは、URL にするとそちらが返る
const RESERVED: [&str; 3] = ["api", "_base_fs", "_headers"];

/// path（Vault の中の場所。例: 2_Areas/会社/メモ.md）を、リンクで開けるか
pub fn linkable(path: &str) -> bool {
    let Some(name) = path.strip_suffix(".md") else { return false };
    // 末尾が拡張子に見える名前（メモ.2024、photo.png）は、画面が .md を補わずに別のファイルとして読む
    let looks_like_file = name.rsplit_once('.').is_some_and(|(_, ext)| !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphanumeric()));
    path.len() <= 1024
        && !path.starts_with("Library/Std/")
        && !RESERVED.contains(&name.split('/').next().unwrap_or(""))
        // # @ $ は見出し・位置・目印の指定に、先頭の ^ は同梱ページの指定になる。| < > [[ ]] は名前として読めない
        && !name.starts_with('^')
        && !name.contains(|c: char| c.is_control() || "@#$|<>\\".contains(c))
        && !name.contains("[[")
        && !name.contains("]]")
        && name.split('/').all(|part| !part.is_empty() && !part.starts_with('.'))
        && !looks_like_file
}

#[cfg(test)]
mod tests {
    use super::linkable;

    #[test]
    fn follows_the_shared_cases() {
        let mut seen = 0;
        for line in include_str!("linkable_cases.txt").lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
            let (expected, path) = line.split_once('\t').expect("ok/no<TAB>path");
            assert_eq!(linkable(path), expected == "ok", "{path}");
            seen += 1;
        }
        assert!(seen > 30);
    }

    #[test]
    fn refuses_control_characters_and_overlong_paths() {
        for path in ["a\nb.md", "a\tb.md", "a\0b.md", "a\u{7f}b.md"] {
            assert!(!linkable(path), "{path:?}");
        }
        assert!(linkable(&format!("{}.md", "a".repeat(1021))));
        assert!(!linkable(&format!("{}.md", "a".repeat(1022))));
    }
}
