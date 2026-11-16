//! rootlore update: 配布中の CLI が新しければ、取ってきて入れ替える。
//! 中身は、アプリの更新と同じ鍵（desktop/src-tauri/tauri.conf.json の plugins.updater.pubkey）の署名で確かめる。
//! アプリに同梱した CLI（.app の中）は入れ替えない。アプリを更新すると新しくなる（desktop/src-tauri/src/cli_link.rs）。
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;

const MANIFEST: &str = "https://raw.githubusercontent.com/tanakaisworking/rootlore-releases/main/cli-latest.json";
/// アプリの更新と同じ公開鍵。対になる秘密鍵で署名したものだけを入れる
const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDA3RjNGMEJGQzNDOTMxMkQKUldRdE1jbkR2L0R6QjBNdG1oREhoTTN1WlJWcm9DMVZVMzlaSkpEeDVlQ0RjRUlwQUhwaFhTN0oK";
const MAX_SIZE: u64 = 64 << 20;

#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: HashMap<String, Asset>,
}

#[derive(Deserialize)]
struct Asset {
    url: String,
    signature: String,
}

pub fn run() -> Result<(), String> {
    let exe = std::env::current_exe().and_then(fs::canonicalize).map_err(|e| format!("自分の場所が分かりません: {e}"))?;
    if exe.parent().is_some_and(|dir| dir.ends_with("Contents/MacOS")) {
        return Err("この rootlore は Rootlore アプリに入っているものです。アプリを更新すると新しくなります。".into());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(120))
        .user_agent(concat!("rootlore-cli/", env!("CARGO_PKG_VERSION")))
        .build();
    let manifest_url = std::env::var("ROOTLORE_UPDATE_MANIFEST").unwrap_or_else(|_| MANIFEST.into());
    let manifest: Manifest = agent
        .get(&manifest_url)
        .call()
        .map_err(|e| format!("配布中の版を確かめられません: {e}"))?
        .into_json()
        .map_err(|e| format!("配布中の版の情報が読めません: {e}"))?;
    let current = env!("CARGO_PKG_VERSION");
    if !newer(&manifest.version, current)? {
        println!("最新です（{current}）。");
        return Ok(());
    }
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let asset = manifest
        .platforms
        .get(&platform)
        .ok_or_else(|| format!("{} には、この PC（{platform}）向けの版がありません。", manifest.version))?;
    let mut data = Vec::new();
    agent
        .get(&asset.url)
        .call()
        .map_err(|e| format!("新しい版を取ってこられません: {e}"))?
        .into_reader()
        .take(MAX_SIZE)
        .read_to_end(&mut data)
        .map_err(|e| format!("新しい版を取ってこられません: {e}"))?;
    verify(PUBKEY, &data, &asset.signature)?;
    replace(&exe, &data)?;
    println!("{current} から {} に更新しました。", manifest.version);
    Ok(())
}

fn version(text: &str) -> Result<(u64, u64, u64), String> {
    let parts: Vec<u64> = text.trim().split('.').map(str::parse).collect::<Result<_, _>>().map_err(|_| format!("版の書き方が違います: {text}"))?;
    match parts[..] {
        [a, b, c] => Ok((a, b, c)),
        _ => Err(format!("版の書き方が違います: {text}")),
    }
}

fn newer(latest: &str, current: &str) -> Result<bool, String> {
    Ok(version(latest)? > version(current)?)
}

/// 鍵も署名も、tauri signer が出す形（minisign の文面を base64 にしたもの）
fn verify(pubkey: &str, data: &[u8], signature: &str) -> Result<(), String> {
    let text = |b64: &str| STANDARD.decode(b64.trim()).ok().and_then(|b| String::from_utf8(b).ok());
    let key = text(pubkey).and_then(|t| PublicKey::decode(&t).ok()).ok_or("公開鍵が読めません")?;
    let sig = text(signature).and_then(|t| Signature::decode(&t).ok()).ok_or("署名が読めません")?;
    key.verify(data, &sig, true).map_err(|_| "署名が合いません。入れ替えをやめました。".to_string())
}

/// 同じフォルダに書いてから置き換える。途中で失敗しても、今の rootlore は残る
fn replace(exe: &Path, data: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let staged = exe.with_file_name(format!(".rootlore-update-{}", std::process::id()));
    let result = fs::write(&staged, data)
        .and_then(|_| fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)))
        .and_then(|_| fs::rename(&staged, exe));
    if let Err(e) = result {
        let _ = fs::remove_file(&staged);
        return Err(format!("{} を入れ替えられません: {e}", exe.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(newer("0.2.0", "0.1.9").unwrap());
        assert!(newer("0.10.0", "0.9.0").unwrap());
        assert!(!newer("0.1.0", "0.1.0").unwrap());
        assert!(!newer("0.1.0", "0.2.0").unwrap());
        assert!(newer("1.0", "0.1.0").is_err());
    }

    #[test]
    fn uses_the_app_update_key() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../desktop/src-tauri/tauri.conf.json")).unwrap();
        assert_eq!(conf["plugins"]["updater"]["pubkey"], PUBKEY);
    }

    // テスト用の鍵で署名したもの（npx tauri signer generate / sign で作った）
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDA4MjFBMTE5QjUzMzU0RDgKUldUWVZETzFHYUVoQ05vQTh4am9NcjdPa0w4TG5jczNKL0VabEFreVVQbEQyb3hEYnB6Rll4QW0K";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUWVZETzFHYUVoQ0lJdnJ4NzY5bmRKTGtrUHB5S3N6VlJZejhEdE5ScTcwbmtTaDUvbVV0L3JLNTJiV3hsYmtZZElrbFBVVWdjS21LYzFKeWMwQVBsbGNTQ0N4cU9uSndVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0ODQ5MDkzCWZpbGU6ZGF0YQpMQUdXV002UU5nYXUvaFZoSU5tUEFJZzlQanlDY2c2TmdDY3pNaFpZM0VSU1dmOTJnMndUZzBod1RXeXRWNFl4UHdKTjhSVnZuL3BHaG5kMWdkaFFDZz09Cg==";

    #[test]
    fn accepts_only_signed_data() {
        assert!(verify(TEST_PUBKEY, b"rootlore test\n", TEST_SIGNATURE).is_ok());
        assert!(verify(TEST_PUBKEY, b"rootlore test!\n", TEST_SIGNATURE).is_err());
        assert!(verify(PUBKEY, b"rootlore test\n", TEST_SIGNATURE).is_err());
    }
}
