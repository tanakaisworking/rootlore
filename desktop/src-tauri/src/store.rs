// Rootlore のデスクトップ版: 繋ぎ先の記憶。
//
// 選んだ繋ぎ方（GitHub App か、トークン直か）と、リポジトリを残す。
// トークンそのものは macOS の Keychain に置く（画面の JavaScript にも、設定ファイルにも書かない）。
//
// - GitHub App 方式: うちのサーバー（rootlore.app）が発行したトークン。失効したら更新する
// - トークン直方式: ユーザーが作った Personal Access Token。アプリが直接 GitHub を叩く
//
// 環境変数 ROOTLORE_GITHUB_TOKEN があれば、トークン直方式でそのトークンを使い、Keychain には一切触らない
// （読まない・書かない・消さない。確認の画面も出ない）。開発ビルドや自動の確認で、Keychain の許可に頼らずに動かすため。

use serde::{Deserialize, Serialize};

const SERVICE: &str = "jp.hibachi.rootlore";
const ACCOUNT: &str = "github-token";
/// GitHub App 方式のログイン（うちのサーバーのセッションの Cookie）。開き直しや更新でつなぎ直さなくて済むように残す
const SESSION_ACCOUNT: &str = "app-session";
/// Keychain の代わりに使うトークンの環境変数
pub const TOKEN_ENV: &str = "ROOTLORE_GITHUB_TOKEN";

/// 環境変数のトークン。空なら無いのと同じ
pub fn env_token() -> Option<String> {
    token_from(std::env::var(TOKEN_ENV).ok())
}

fn token_from(value: Option<String>) -> Option<String> {
    value.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Keychain の項目。Keychain に触るのは必ずここを通す。
/// 環境変数のトークンがあるときは Ok(None)（項目を作らず、読む・書く・消すのどれもしない）
fn keychain_entry(account: &str) -> Result<Option<keyring::Entry>, String> {
    if env_token().is_some() {
        return Ok(None);
    }
    keyring::Entry::new(SERVICE, account).map(Some).map_err(|e| e.to_string())
}

/// GitHub App 方式のセッションを Keychain から読む
pub fn read_session() -> Option<String> {
    let entry = keychain_entry(SESSION_ACCOUNT).ok()??;
    entry.get_password().ok().filter(|c| c.starts_with("vw_session="))
}

/// GitHub App 方式のセッションを Keychain に置く（ログインしたときと、更新したとき）
pub fn write_session(cookie: &str) -> Result<(), String> {
    let Some(entry) = keychain_entry(SESSION_ACCOUNT)? else {
        return Ok(());
    };
    entry.set_password(cookie).map_err(|e| e.to_string())
}

/// GitHub App 方式のセッションを消す（トークンでつなぎ直したとき）
pub fn clear_session() {
    if let Ok(Some(entry)) = keychain_entry(SESSION_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

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

/// トークンを読む（環境変数にあればそれ、無ければ Keychain から）
pub fn read_token() -> Option<String> {
    if let Some(token) = env_token() {
        return Some(token);
    }
    let entry = keychain_entry(ACCOUNT).ok()??;
    entry.get_password().ok().filter(|t| !t.is_empty())
}

/// トークンを Keychain に置く（環境変数のトークンがあるときは置かない。次に開いたときも環境変数のトークンを使う）
pub fn write_token(token: &str) -> Result<(), String> {
    let Some(entry) = keychain_entry(ACCOUNT)? else {
        return Ok(());
    };
    entry.set_password(token).map_err(|e| e.to_string())
}

/// トークンを消す（繋ぎ直すとき、ログアウトするとき）
pub fn clear_token() -> Result<(), String> {
    let Some(entry) = keychain_entry(ACCOUNT)? else {
        return Ok(());
    };
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
    fn env_token_ignores_blank_values() {
        assert_eq!(token_from(None), None);
        assert_eq!(token_from(Some("".into())), None);
        assert_eq!(token_from(Some("  \n".into())), None);
        assert_eq!(token_from(Some(" ghp_x \n".into())), Some("ghp_x".into()));
    }

    /// 環境変数のトークンがあれば、Keychain の項目を作らず、読む・書く・消すがどれも Keychain に届かない。
    /// 環境変数を書き換えるのはこのテストだけ（ほかのテストは Keychain と環境変数を使わない）
    #[test]
    fn env_token_keeps_keychain_untouched() {
        std::env::set_var(TOKEN_ENV, " ghp_from_env_for_test ");
        assert!(matches!(keychain_entry(ACCOUNT), Ok(None)));
        assert!(matches!(keychain_entry(SESSION_ACCOUNT), Ok(None)));
        assert_eq!(read_token().as_deref(), Some("ghp_from_env_for_test"));
        assert_eq!(read_session(), None);
        assert_eq!(write_token("ghp_other"), Ok(()));
        assert_eq!(write_session("vw_session=x"), Ok(()));
        assert_eq!(clear_token(), Ok(()));
        clear_session();
        std::env::remove_var(TOKEN_ENV);
    }

    #[test]
    fn owner_repo() {
        let c = Connection { mode: Mode::Token, repo: "me/notes".into(), branch: "main".into() };
        assert_eq!(c.owner_repo(), Some(("me".into(), "notes".into())));
        let bad = Connection { mode: Mode::Token, repo: "notes".into(), branch: "main".into() };
        assert_eq!(bad.owner_repo(), None);
    }
}
