//! HTTP の接続口。HTTPS_PROXY / https_proxy（http の宛先は HTTP_PROXY / http_proxy）と NO_PROXY / no_proxy を見て、
//! プロキシを通すか決める。証明書は、同梱のルート証明書に OS の証明書（Linux なら SSL_CERT_FILE など）を足して確かめる。
//! プロキシが TLS を中継し直す環境（社内網・エージェントのサンドボックス）では、その証明書が OS 側にだけ入っているため。
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// url に向けた接続口。プロキシは宛先ごとに決める（NO_PROXY で外す宛先があるため）
pub fn agent(url: &str, timeout: Duration) -> ureq::AgentBuilder {
    let mut builder = ureq::AgentBuilder::new()
        .timeout(timeout)
        .user_agent(concat!("rootlore-cli/", env!("CARGO_PKG_VERSION")))
        .tls_config(tls());
    if let Some(proxy) = proxy_for(url, |key| std::env::var(key).ok()) {
        match ureq::Proxy::new(&proxy) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(e) => eprintln!("rootlore: プロキシの指定が読めないので、使わずに続けます（{e}）"),
        }
    }
    builder
}

fn tls() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
            roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("TLS の既定の設定")
                .with_root_certificates(roots)
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

/// url の宛先に使うプロキシ。env は環境変数を引く（テストで差し替える）
fn proxy_for(url: &str, env: impl Fn(&str) -> Option<String>) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = host_of(rest);
    let first = |keys: &[&str]| keys.iter().find_map(|k| env(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()));
    if let Some(list) = first(&["NO_PROXY", "no_proxy"]) {
        if bypass(&host, &list) {
            return None;
        }
    }
    match scheme.to_ascii_lowercase().as_str() {
        "https" => first(&["HTTPS_PROXY", "https_proxy"]),
        "http" => first(&["HTTP_PROXY", "http_proxy"]),
        _ => None,
    }
}

/// 「user@host:port/path」から、小文字の host（IPv6 は括弧なし）
fn host_of(rest: &str) -> String {
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// NO_PROXY の書き方: カンマ区切り。「*」はすべて。「example.com」「.example.com」は、その名前と下の名前すべて。
/// 「host:port」の port は見ない
fn bypass(host: &str, list: &str) -> bool {
    list.split(',').map(str::trim).filter(|e| !e.is_empty()).any(|entry| {
        if entry == "*" {
            return true;
        }
        let entry = match entry.strip_prefix('[') {
            Some(v6) => v6.split(']').next().unwrap_or(""),
            None if entry.matches(':').count() == 1 => entry.split(':').next().unwrap_or(""),
            None => entry,
        };
        let entry = entry.trim_start_matches("*.").trim_start_matches('.').trim_end_matches('.').to_ascii_lowercase();
        !entry.is_empty() && (host == entry || host.ends_with(&format!(".{entry}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    #[test]
    fn uses_the_proxy_for_the_scheme() {
        let vars = [("HTTPS_PROXY", "http://proxy:3128"), ("HTTP_PROXY", "http://plain:8080")];
        assert_eq!(proxy_for("https://rootlore.app/.auth/me", env(&vars)).as_deref(), Some("http://proxy:3128"));
        assert_eq!(proxy_for("http://127.0.0.1:8790/", env(&vars)).as_deref(), Some("http://plain:8080"));
        assert_eq!(proxy_for("https://rootlore.app/", env(&[("https_proxy", "http://lower:1")])).as_deref(), Some("http://lower:1"));
        assert_eq!(proxy_for("https://rootlore.app/", env(&[("HTTPS_PROXY", " ")])), None);
        assert_eq!(proxy_for("https://rootlore.app/", env(&[])), None);
    }

    #[test]
    fn no_proxy_skips_matching_hosts() {
        let with = |no: &'static str| [("HTTPS_PROXY", "http://proxy:3128"), ("no_proxy", no)];
        assert_eq!(proxy_for("https://rootlore.app/x", env(&with("rootlore.app"))), None);
        assert_eq!(proxy_for("https://api.rootlore.app/x", env(&with(".rootlore.app"))), None);
        assert_eq!(proxy_for("https://api.rootlore.app/x", env(&with("localhost, rootlore.app"))), None);
        assert_eq!(proxy_for("https://ROOTLORE.app:443/x", env(&with("rootlore.app:443"))), None);
        assert_eq!(proxy_for("https://github.com/x", env(&with("*"))), None);
        assert_eq!(proxy_for("https://[::1]:8790/x", env(&with("[::1]"))), None);
        assert_eq!(proxy_for("https://user@rootlore.app/x", env(&with("rootlore.app"))), None);
        // 名前の途中が同じだけのものは外さない
        assert!(proxy_for("https://notrootlore.app/x", env(&with("rootlore.app"))).is_some());
        assert!(proxy_for("https://github.com/x", env(&with("rootlore.app"))).is_some());
    }

    #[test]
    fn builds_a_tls_config() {
        tls();
    }
}
