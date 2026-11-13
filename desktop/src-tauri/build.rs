fn main() {
    // アプリの命令 report を、外のサイト（Rootlore）から呼べる許可の対象にする（capabilities/remote.json）
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["report", "mcp_result", "set_menu_state"])),
    )
    .expect("failed to run tauri-build");
}
