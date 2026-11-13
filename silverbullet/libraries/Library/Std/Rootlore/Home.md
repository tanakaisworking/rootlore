---
description: vault-web で足したボタン（編集、履歴、最新の状態に更新）
tags: meta
---
vault-web で足したもの。開いているノートをこの画面で直して GitHub に保存するボタン（`client/vault_web_edit.ts`、`client/components/vault_web_note_editor.tsx`）と、GitHub の最新を取りに行く更新ボタン。編集ボタンと履歴のボタン（GitHub でノートの変更の履歴を開く）は上部のバーの右端（`client/editor_ui.tsx`）、ほかのボタンは左のサイドバーと細い帯に「ホーム、更新、検索」の順に並ぶ（`client/components/vault_web_sidebar_actions.tsx`。並びは priority の大きい順）。サイドバーを開くボタンは、細い帯とスマートフォンの「☰」にある。

起動時にも読む（`client/boot.ts`）。初回は索引が終わるまでほかの Lua が読み込まれないので、`actionButton.define` を使わずに設定へ直接足す。ホーム（最近の更新）は `client/vault_web_home.ts`。

# Implementation
```space-lua
-- priority: 10
table.insert(config.get("actionButtons", {}), {
  icon = "edit-3",
  description = "編集",
  command = "Vault: Edit note",
  priority = 4.5,
  dropdown = false,
})
table.insert(config.get("actionButtons", {}), {
  icon = "clock",
  description = "履歴",
  command = "Vault: Note history",
  priority = 4.4,
  dropdown = false,
})
table.insert(config.get("actionButtons", {}), {
  icon = "refresh-cw",
  description = "最新の状態に更新",
  command = "Sync: Space",
  priority = 2.5,
  dropdown = false,
})
```
