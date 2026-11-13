// アプリの更新: 公開している latest.json を見て、新しい版があれば入れて開き直す。
// 置き場所は `tauri.conf.json` の `plugins.updater`（配布用のリポジトリの latest.json）。
// 中身が本物かは、ビルドに埋めた公開鍵で確かめる（合わないものは入れない）。
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

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

/// 起動の少しあとで静かに確かめる（画面の読み込みを邪魔しない）
pub fn check_after_start(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        tauri::async_runtime::spawn(async move { check(app, true).await });
    });
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
