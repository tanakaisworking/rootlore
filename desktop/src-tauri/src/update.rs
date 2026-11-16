// アプリの更新: 公開している latest.json を見て、新しい版があれば入れて開き直す。
// 置き場所は `tauri.conf.json` の `plugins.updater`（配布用のリポジトリの latest.json）。
// 中身が本物かは、ビルドに埋めた公開鍵で確かめる（合わないものは入れない）。
// 自動の確認（起動の少しあとと、その後2時間おき）は尋ねずに裏で受け取り、アプリを終了するときに入れ替える。
// 開いている間に入れ替えると、動いている版と同梱の画面がずれるので、入れ替えは終了時にする。
// メニューの「アップデートを確認…」だけは、尋ねてから入れ替えて開き直す。
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

const INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);

/// 裏で受け取った新しい版。アプリを終了するときに入れ替える
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

fn text<'a>(language: &str, ja: &'a str, en: &'a str) -> &'a str {
    if language == "ja" { ja } else { en }
}

fn log(stage: &str, extra: serde_json::Value) {
    let mut body = serde_json::json!({ "stage": stage });
    if let (Some(map), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            map.insert(key.clone(), value.clone());
        }
    }
    crate::log(&body.to_string());
}

/// 起動の少しあと（画面の読み込みを邪魔しない）と、その後2時間おきに静かに確かめる
pub fn check_after_start(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        loop {
            tauri::async_runtime::block_on(fetch_in_background(app.clone()));
            std::thread::sleep(INTERVAL);
        }
    });
}

/// 新しい版があれば、尋ねずに受け取っておく（入れ替えは install_pending）
async fn fetch_in_background(app: AppHandle) {
    log("update-check", serde_json::json!({ "silent": true }));
    let update = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let update = match update {
        Ok(Some(update)) => update,
        Ok(None) => return log("update-none", serde_json::json!({})),
        Err(error) => return log("update-error", serde_json::json!({ "error": error.to_string() })),
    };
    let state = app.state::<Pending>();
    let already = state.0.lock().ok().is_some_and(|p| p.as_ref().is_some_and(|(u, _)| u.version == update.version));
    if already {
        return;
    }
    log("update-available", serde_json::json!({ "version": update.version }));
    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => {
            log("update-downloaded", serde_json::json!({ "version": update.version }));
            if let Ok(mut pending) = state.0.lock() {
                *pending = Some((update, bytes));
            }
        }
        Err(error) => log("update-error", serde_json::json!({ "error": error.to_string() })),
    }
}

/// アプリを終了するときに、受け取っておいた新しい版に入れ替える（次に開くと新しい版になる）
pub fn install_pending(app: &AppHandle) {
    let Some(state) = app.try_state::<Pending>() else { return };
    let Some((update, bytes)) = state.0.lock().ok().and_then(|mut p| p.take()) else { return };
    match update.install(&bytes) {
        Ok(()) => log("update-installed-on-exit", serde_json::json!({ "version": update.version })),
        Err(error) => log("update-error", serde_json::json!({ "error": error.to_string() })),
    }
}

/// メニューの「アップデートを確認…」から。結果は必ず知らせる
pub fn check_from_menu(app: AppHandle) {
    tauri::async_runtime::spawn(async move { check(app, false).await });
}

async fn check(app: AppHandle, silent: bool) {
    let language = crate::menu::language(&app);
    log("update-check", serde_json::json!({ "silent": silent }));
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            log("update-error", serde_json::json!({ "error": error.to_string() }));
            if !silent {
                alert(&app, &language, "更新を確認できませんでした。", "Could not check for updates.");
            }
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            log("update-available", serde_json::json!({ "version": update.version }));
            ask(&app, &language, update);
        }
        Ok(None) => {
            log("update-none", serde_json::json!({}));
            if !silent {
                alert(&app, &language, "いまが最新です。", "You're up to date.");
            }
        }
        Err(error) => {
            log("update-error", serde_json::json!({ "error": error.to_string() }));
            if !silent {
                alert(&app, &language, "更新を確認できませんでした。", "Could not check for updates.");
            }
        }
    }
}

fn alert(app: &AppHandle, language: &str, ja: &str, en: &str) {
    app.dialog()
        .message(text(language, ja, en))
        .title("Rootlore")
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

fn ask(app: &AppHandle, language: &str, update: tauri_plugin_updater::Update) {
    let message = if language == "ja" {
        format!("新しい版（{}）があります。いま更新しますか？", update.version)
    } else {
        format!("Version {} is available. Update now?", update.version)
    };
    let ok = text(language, "更新する", "Update").to_string();
    let later = text(language, "あとで", "Later").to_string();
    let handle = app.clone();
    let language = language.to_string();
    app.dialog()
        .message(message)
        .title("Rootlore")
        .buttons(MessageDialogButtons::OkCancelCustom(ok, later))
        .show(move |proceed| {
            if !proceed {
                log("update-declined", serde_json::json!({ "version": update.version }));
                return;
            }
            let app = handle.clone();
            let language = language.clone();
            // メニューから入れ替えるので、裏で受け取っておいた分は終了時に入れ直さない
            if let Some(state) = app.try_state::<Pending>() {
                if let Ok(mut pending) = state.0.lock() {
                    pending.take();
                }
            }
            tauri::async_runtime::spawn(async move {
                log("update-install", serde_json::json!({ "version": update.version }));
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        log("update-installed", serde_json::json!({ "version": update.version }));
                        app.restart();
                    }
                    Err(error) => {
                        log("update-error", serde_json::json!({ "error": error.to_string() }));
                        alert(&app, &language, "更新を入れられませんでした。", "Could not install the update.");
                    }
                }
            });
        });
}
