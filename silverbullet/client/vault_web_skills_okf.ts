// vault-web: 内蔵カタログの1件目、OKF（Open Knowledge Format）。
// 本家の仕様（v0.2）を、Vault を整理する手順書として書き直したもの。原文は英語なので、要点だけ日本語にしている。
// 出典: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
// 中身を直すときは、この文字列をそのまま書き換える（インストール済みの Vault には反映されない）。
export const OKF_SKILL = `---
name: okf
description: ノートのリポジトリを Open Knowledge Format（OKF）の形に整理する。1概念1ファイル、YAML frontmatter の type、index.md による段階的な一覧、リンクで関係を表す。ノートの棚卸し・構造化・バンドル化を頼まれたときに使う。
metadata:
  source: https://github.com/GoogleCloudPlatform/open-knowledge-format
  spec: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
  version: "0.2"
---

# OKF でリポジトリを整理する

OKF（Open Knowledge Format）は、知識を Markdown と YAML frontmatter だけで表すための形式です。
特定のツールやサービスに依存しないので、Git のまま置いておけます。

このスキルは、手元のノートを OKF の「バンドル」（= ディレクトリ1つ）として整理するための手順です。

## いつ使うか

- ノートが増えて、どこに何があるか分からなくなった
- 同じ話題のメモが何ファイルにも分かれている
- エージェントに読ませる前に、知識の形をそろえたい
- ディレクトリを「バンドル」として切り出して、ほかの場所でも使いたい

## 基本の形

\`\`\`text
bundle/
  index.md          # 任意。ディレクトリの一覧（段階的に辿るため）
  log.md            # 任意。更新の履歴
  <概念>.md         # バンドルの直下の概念
  <サブディレクトリ>/
    index.md
    <概念>.md
\`\`\`

- **1概念 = 1ファイル**。1ファイルに複数の話題を詰め込まない
- \`index.md\` と \`log.md\` は予約名。概念のファイルには使わない
- ディレクトリの分け方は自由。ドメインに合わせて決める

## frontmatter

\`\`\`yaml
---
type: 概念の種類          # 必須
title: 表示名             # 任意
description: 1行の要約     # 任意（一覧と検索に出る）
resource: <実体のURI>     # 任意（実体があるときだけ）
tags: [tag, tag]         # 任意
status: active           # 任意（active / deprecated / draft など）
---
\`\`\`

- 必須は \`type\` だけ。\`type\` は自由な文字列で、\`Reference\` \`Playbook\` \`Metric\` \`Note\` のように自己説明的に書く
- 一覧・検索・振り分けに使う項目だけ frontmatter に置き、本文は読むための文章に使う
- 出典を残すときは \`sources\` に書く

\`\`\`yaml
sources:
  - id: spec
    resource: https://example.com/spec
    title: 仕様書
\`\`\`

## 本文

- 見出し・箇条書き・表・コードブロックを使う。読み物としての文章より、構造を優先する
- 概念どうしの関係は、普通の Markdown リンクで書く（\`[請求書の作り方](billing/invoice.md)\`）
- 外部の主張には、\`sources\` の \`id\` を脚注で対応させる

## index.md

ディレクトリの一覧。frontmatter は書かない（バンドルの直下だけ \`okf_version\` を書ける）。

\`\`\`markdown
# 請求

* [請求書の作り方](billing/invoice.md) - 毎月の請求の手順
* [入金の確認](billing/payment.md) - 入金消込のやり方
\`\`\`

## log.md

更新の履歴。新しい順に、日付でまとめる。

\`\`\`markdown
# 更新の記録

## 2026-11-10

- \`billing/invoice.md\` を追加
\`\`\`

## 整理の手順

1. **範囲を決める**。まずは1ディレクトリだけをバンドルにする。全体を一度に動かさない
2. **概念を洗い出す**。ファイル名ではなく「何についての知識か」で分ける
3. **1概念1ファイルに分ける**。分けられないものは、まだ概念になっていない
4. **\`type\` を決める**。同じ種類には同じ \`type\` を使う
5. **関係をリンクにする**。親子はディレクトリ、横のつながりはリンク
6. **\`index.md\` を置く**。1階層ぶんだけ一覧にする
7. **\`log.md\` に記録する**。何をどこへ動かしたかを残す

## やらないこと

- 既存のノートを、確認なしに削除・統合しない。動かすときは \`git mv\` で履歴を残す
- 全ノートを一括で frontmatter 付けしない。まず1バンドルで試す
- \`index.md\` / \`log.md\` を概念のファイル名に使わない
- 実体のないものに \`resource\` を書かない

## 出典

- [Open Knowledge Format（仕様 v0.2）](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)
`;
