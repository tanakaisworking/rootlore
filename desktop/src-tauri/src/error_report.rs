//! アプリ本体（Rust）で受け止めた失敗を、画面のエラーと同じ経路で送る（Worker の /v/api/errors → Sentry。worker/errors.ts）。
//! 送るのは、どの入口か、失敗の文（ノートの名前やパスは Worker が伏せる）、ソースの場所、版だけ。
//! 画面の設定「エラーの報告」がオフなら送らない。画面が設定を知らせるまでは送らずに溜めておき、知らせを受けてから送るか捨てる。
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ENDPOINT: &str = "https://rootlore.app/v/api/errors";
/// 1回の起動で送る数の上限（同じ失敗が続いても送りすぎない）
const MAX_PER_RUN: usize = 10;

struct Reporter {
    /// 画面から知らされた設定。知らされるまでは None
    enabled: Option<bool>,
    queue: Vec<String>,
    sent: usize,
}

static REPORTER: Mutex<Reporter> = Mutex::new(Reporter { enabled: None, queue: Vec::new(), sent: 0 });

/// guard.rs が受け止めた panic を送る（設定がまだ分からなければ溜める）
pub fn panic(entry: &str, message: &str, location: Option<(String, u32)>) {
    let envelope = envelope(entry, message, location);
    let ready = {
        let mut reporter = crate::guard::lock(&REPORTER);
        match reporter.enabled {
            Some(false) => return,
            None => {
                if reporter.queue.len() < MAX_PER_RUN {
                    reporter.queue.push(envelope);
                }
                return;
            }
            Some(true) => {
                if reporter.sent >= MAX_PER_RUN {
                    return;
                }
                reporter.sent += 1;
                envelope
            }
        }
    };
    send(ready);
}

/// 画面から、報告するかを受け取る（起動時と、設定を変えたとき。vault_web_error_reports.ts）
#[tauri::command]
pub fn set_error_reports(enabled: bool) {
    crate::guard::run("set-error-reports", || {
        let ready = {
            let mut reporter = crate::guard::lock(&REPORTER);
            reporter.enabled = Some(enabled);
            let queued = std::mem::take(&mut reporter.queue);
            if !enabled {
                return;
            }
            let room = MAX_PER_RUN.saturating_sub(reporter.sent);
            let ready: Vec<String> = queued.into_iter().take(room).collect();
            reporter.sent += ready.len();
            ready
        };
        for envelope in ready {
            send(envelope);
        }
    });
}

fn send(envelope: String) {
    // 送るのは別スレッドで。届かなくても、アプリは待たせない
    std::thread::spawn(move || {
        let _ = ureq::post(ENDPOINT)
            .set("Content-Type", "text/plain;charset=UTF-8")
            .timeout(Duration::from_secs(10))
            .send_string(&envelope);
    });
}

/// Sentry の envelope（1行目は空のヘッダー、2行目は種類、3行目はイベント）。送り先は Worker が付け直す
fn envelope(entry: &str, message: &str, location: Option<(String, u32)>) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let frame = match location {
        Some((file, line)) => serde_json::json!({ "function": entry, "filename": source_path(&file), "lineno": line, "in_app": true }),
        None => serde_json::json!({ "function": entry, "in_app": true }),
    };
    let event = serde_json::json!({
        "event_id": uuid::Uuid::new_v4().simple().to_string(),
        "timestamp": now,
        "level": "error",
        "environment": if cfg!(debug_assertions) { "development" } else { "production" },
        "release": concat!("rootlore@", env!("CARGO_PKG_VERSION")),
        "tags": { "surface": "desktop" },
        "exception": { "values": [{
            "type": "RustPanic",
            "value": message,
            "mechanism": { "type": "guard", "handled": true },
            "stacktrace": { "frames": [frame] },
        }] },
    });
    format!("{{}}\n{{\"type\":\"event\"}}\n{event}")
}

/// 依存ライブラリの場所は、ビルドした PC の絶対パスになる。最後の3つ（例: tauri-2.12.5/src/app.rs）だけにする
fn source_path(file: &str) -> String {
    if !file.starts_with('/') {
        return file.to_string();
    }
    let parts: Vec<&str> = file.split('/').filter(|p| !p.is_empty()).collect();
    parts[parts.len().saturating_sub(3)..].join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_envelope_has_only_what_the_worker_keeps() {
        let text = envelope("deep-link-login", "state() called before manage()", Some(("src/main.rs".into(), 239)));
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        let event: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
        let exception = &event["exception"]["values"][0];
        assert_eq!(exception["type"], "RustPanic");
        assert_eq!(exception["stacktrace"]["frames"][0]["filename"], "src/main.rs");
        assert_eq!(exception["stacktrace"]["frames"][0]["function"], "deep-link-login");
        assert_eq!(event["tags"]["surface"], "desktop");
        assert!(event["release"].as_str().unwrap().starts_with("rootlore@"));
    }

    #[test]
    fn library_paths_drop_the_builders_home() {
        assert_eq!(source_path("/Users/someone/.cargo/registry/src/x/tauri-2.12.5/src/app.rs"), "tauri-2.12.5/src/app.rs");
        assert_eq!(source_path("src/main.rs"), "src/main.rs");
    }
}
