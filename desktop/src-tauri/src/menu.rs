use std::sync::Mutex;
use tauri::{AppHandle, Manager, Wry};
use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};

#[derive(Default)]
pub struct MenuState(Mutex<Option<(String, MenuItem<Wry>)>>);

fn text<'a>(language: &str, ja: &'a str, en: &'a str) -> &'a str {
    if language == "ja" { ja } else { en }
}

fn build(app: &AppHandle, language: &str, can_save: bool) -> tauri::Result<(Menu<Wry>, MenuItem<Wry>)> {
    let t = |ja, en| text(language, ja, en);
    let item = |id, label, key: Option<&str>| MenuItem::with_id(app, id, label, true, key);
    let settings = item("settings", t("設定…", "Settings…"), Some("CmdOrCtrl+,"))?;
    let app_menu = SubmenuBuilder::new(app, "Rootlore")
        .about_with_text(t("Rootloreについて", "About Rootlore"), Some(AboutMetadata { name: Some("Rootlore".into()), version: Some(env!("CARGO_PKG_VERSION").into()), ..Default::default() }))
        .separator().item(&settings).separator()
        .services_with_text(t("サービス", "Services")).separator()
        .hide_with_text(t("Rootloreを隠す", "Hide Rootlore"))
        .hide_others_with_text(t("ほかを隠す", "Hide Others"))
        .show_all_with_text(t("すべてを表示", "Show All")).separator()
        .quit_with_text(t("Rootloreを終了", "Quit Rootlore")).build()?;
    let save = MenuItem::with_id(app, "save", t("保存", "Save"), can_save, Some("CmdOrCtrl+S"))?;
    let file = SubmenuBuilder::new(app, t("ファイル", "File"))
        .item(&item("new", t("新規作成…", "New Note…"), Some("CmdOrCtrl+N"))?)
        .item(&item("open", t("ノートを開く…", "Open Note…"), Some("CmdOrCtrl+K"))?)
        .separator().item(&save)
        .item(&item("edit", t("ノートを編集", "Edit Note"), Some("CmdOrCtrl+E"))?)
        .separator().item(&PredefinedMenuItem::close_window(app, Some(t("ウインドウを閉じる", "Close Window")))?).build()?;
    let edit = SubmenuBuilder::new(app, t("編集", "Edit"))
        .undo_with_text(t("取り消す", "Undo")).redo_with_text(t("やり直す", "Redo"))
        .separator().text("undo_move", t("ファイル移動を取り消す", "Undo File Move"))
        .text("redo_move", t("ファイル移動をやり直す", "Redo File Move"))
        .separator().cut_with_text(t("切り取り", "Cut")).copy_with_text(t("コピー", "Copy"))
        .paste_with_text(t("貼り付け", "Paste")).select_all_with_text(t("すべてを選択", "Select All")).build()?;
    let view = SubmenuBuilder::new(app, t("表示", "View"))
        .text("home", t("ホーム", "Home"))
        .text("sync", t("GitHubから最新を取得", "Refresh from GitHub"))
        .item(&item("reload", t("再読み込み", "Reload"), Some("CmdOrCtrl+R"))?)
        .separator().fullscreen_with_text(t("フルスクリーン", "Full Screen")).build()?;
    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, t("ウインドウ", "Window"))
        .minimize_with_text(t("しまう", "Minimize")).maximize_with_text(t("拡大／縮小", "Zoom"))
        .separator().bring_all_to_front_with_text(t("すべてを手前に移動", "Bring All to Front")).build()?;
    let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, t("ヘルプ", "Help"))
        .text("shortcuts", t("キーボードショートカット", "Keyboard Shortcuts"))
        .separator().text("check_update", t("アップデートを確認…", "Check for Updates…")).build()?;
    let menu = MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window, &help]).build()?;
    Ok((menu, save))
}

pub fn apply(app: &AppHandle, language: &str, can_save: bool) -> Result<(), String> {
    if !matches!(language, "ja" | "en") { return Err("Unsupported language".into()); }
    let state = app.state::<MenuState>();
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    if let Some((locale, save)) = current.as_ref() {
        if locale == language { return save.set_enabled(can_save).map_err(|e| e.to_string()); }
    }
    let (menu, save) = build(app, language, can_save).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    crate::log(&format!(r#"{{"stage":"native-menu","language":{}}}"#, serde_json::to_string(language).unwrap()));
    *current = Some((language.into(), save));
    Ok(())
}

#[tauri::command]
pub fn set_menu_state(app: AppHandle, language: String, can_save: bool, background_color: Option<String>) -> Result<(), String> {
    let color = background_color.as_deref().map(parse_color).transpose()?;
    apply(&app, &language, can_save)?;
    if let (Some(color), Some(window)) = (color, app.get_webview_window("main")) {
        // WebViewのレイヤーではなく、透明なタイトルバーの下地になるNSWindowの色を合わせる。
        window.as_ref().window().set_background_color(Some(color)).map_err(|e| e.to_string())?;
    }
    crate::log(&format!(r#"{{"stage":"native-menu-state","language":{},"canSave":{can_save},"backgroundColor":{}}}"#, serde_json::to_string(&language).unwrap(), serde_json::to_string(&background_color).unwrap()));
    Ok(())
}

fn parse_color(value: &str) -> Result<tauri::window::Color, String> {
    let hex = value.strip_prefix('#').ok_or("Invalid background color")?;
    if !hex.is_ascii() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid background color".into()); }
    let expanded = if hex.len() == 3 { hex.chars().flat_map(|c| [c, c]).collect::<String>() } else { hex.to_string() };
    if expanded.len() != 6 { return Err("Invalid background color".into()); }
    let channel = |i| u8::from_str_radix(&expanded[i..i + 2], 16).map_err(|e| e.to_string());
    Ok(tauri::window::Color(channel(0)?, channel(2)?, channel(4)?, 255))
}

#[cfg(test)]
mod tests {
    use super::parse_color;
    #[test]
    fn chrome_accepts_only_opaque_hex_colors() {
        assert_eq!(parse_color("#262626").unwrap().0, 38);
        assert_eq!(parse_color("#fff").unwrap().0, 255);
        for value in ["", "#", "#12", "#12345678", "#ffffff;", "#あいう", "url(x)"] {
            assert!(parse_color(value).is_err());
        }
    }
}

/// いま表示している言語（画面から知らされるまでは英語）
pub fn language(app: &AppHandle) -> String {
    app.state::<MenuState>()
        .0
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|(locale, _)| locale.clone()))
        .unwrap_or_else(|| "en".into())
}

pub fn handle(app: &AppHandle, action: &str) {
    if action == "check_update" {
        crate::update::check_from_menu(app.clone());
        return;
    }
    if !matches!(action, "new" | "open" | "save" | "edit" | "settings" | "undo_move" | "redo_move" | "home" | "sync" | "reload" | "shortcuts") { return; }
    if let Some(window) = app.get_webview_window("main") {
        // 画面は、公開中のサイトか、アプリが同梱した手元のサーバーのどちらでも動く
        let ours = window
            .url()
            .map(|u| matches!(u.host_str(), Some("rootlore.app") | Some("127.0.0.1") | Some("localhost")))
            .unwrap_or(false);
        if ours {
            if action == "reload" { let _ = window.eval("location.reload()"); return; }
            let _ = window.eval(&format!("window.rootloreMenuAction?.({});", serde_json::to_string(action).unwrap()));
        }
    }
}
