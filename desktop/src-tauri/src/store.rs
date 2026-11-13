// Rootlore のデスクトップ版: 繋ぎ先の記憶。
//
// 選んだ繋ぎ方（GitHub App か、トークン直か）と、リポジトリを残す。
// トークンそのものは macOS の Keychain に置く（画面の JavaScript にも、設定ファイルにも書かない）。
//
// - GitHub App 方式: うちのサーバー（rootlore.app）が発行したトークン。失効したら更新する
// - トークン直方式: ユーザーが作った Personal Access Token。アプリが直接 GitHub を叩く

use serde::{Deserialize, Serialize};

const SERVICE: &str = "jp.hibachi.rootlore";
const ACCOUNT: &str = "github-token";

/// 繋ぎ方
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// うちのサーバーを通す（GitHub App。便利）
    App,
    /// ユーザーのトークンで直接 GitHub を叩く（完全に独立）
    Token,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Connection {
    pub mode: Mode,
    /// "owner/repo"
    pub repo: String,
    pub branch: String,
}

impl Connection {
    pub fn owner_repo(&self) -> Option<(String, String)> {
        let (owner, repo) = self.repo.split_once('/')?;
        if owner.is_empty() || repo.is_empty() {
            return None;
        }
        Some((owner.to_string(), repo.to_string()))
    }
}

/// 設定を置く場所（アプリのデータのフォルダ）
pub fn settings_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("connection.json")
}

pub fn load(dir: &std::path::Path) -> Option<Connection> {
    let text = std::fs::read_to_string(settings_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(dir: &std::path::Path, connection: &Connection) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(connection).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(dir), text).map_err(|e| e.to_string())
}

/// トークンを Keychain から読む
pub fn read_token() -> Option<String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok()?;
    entry.get_password().ok().filter(|t| !t.is_empty())
}

/// トークンを Keychain に置く
pub fn write_token(token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(token).map_err(|e| e.to_string())
}

/// トークンを消す（繋ぎ直すとき、ログアウトするとき）
pub fn clear_token() -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // 元から無ければ、消せたのと同じ
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// トークンの形を確かめる（GitHub のトークンは、決まった接頭辞で始まる）
pub fn looks_like_token(token: &str) -> bool {
    let token = token.trim();
    (token.starts_with("ghp_") || token.starts_with("github_pat_") || token.starts_with("gho_") || token.starts_with("ghu_"))
        && token.len() >= 20
        && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shape() {
        assert!(looks_like_token("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
        assert!(looks_like_token("github_pat_11ABCDEFG0123456789_abcdefghijklmnop"));
        assert!(!looks_like_token(""));
        assert!(!looks_like_token("ghp_short"));
        assert!(!looks_like_token("not-a-token-value-here-123456"));
        assert!(!looks_like_token("ghp_abcdefghijklmnopqrstuvwxyz0123 456789"));
    }

    #[test]
    fn owner_repo() {
        let c = Connection { mode: Mode::Token, repo: "me/notes".into(), branch: "main".into() };
        assert_eq!(c.owner_repo(), Some(("me".into(), "notes".into())));
        let bad = Connection { mode: Mode::Token, repo: "notes".into(), branch: "main".into() };
        assert_eq!(bad.owner_repo(), None);
    }
}
