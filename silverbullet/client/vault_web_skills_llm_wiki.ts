// vault-web: 内蔵カタログの LLM Wiki。Karpathy の LLM Wiki を、Vault 用の手順書として書き直したもの。
// 出典: https://github.com/Astro-Han/karpathy-llm-wiki
// 中身を直すときは、この文字列をそのまま書き換える（インストール済みの Vault には反映されない）。
export const LLM_WIKI_SKILL = `---
name: llm-wiki
description: 資料を読み込んで、エージェントが保守する wiki を作る。原典を raw に溜め、知識を wiki に書き、索引と更新履歴を持つ。資料の取り込み、wiki への質問、wiki の点検を頼まれたときに使う。
metadata:
  source: https://github.com/Astro-Han/karpathy-llm-wiki
---

# 原典から wiki を作る

Karpathy の LLM Wiki の考え方です。エージェントが wiki を書き、人は読んで質問します。
質問のたびに資料を探し直すのではなく、知識を wiki に積み上げていきます。

## 2つの層

\`\`\`text
raw/     原典。読むだけで、書き換えない
wiki/    知識。エージェントが書く
\`\`\`

- \`raw/<話題>/YYYY-MM-DD-名前.md\` — 取得した資料をそのまま置く
- \`wiki/<話題>/<記事>.md\` — 話題の下は1階層だけ。記事名は概念の名前
- \`wiki/index.md\` — 記事ごとに1行。話題ごとにまとめ、リンク・要約・更新日を書く
- \`wiki/log.md\` — 追記だけの作業履歴

## 取り込む（Ingest）

1. **原典を raw に保存する**。先頭に URL・取得日・公開日を書く。本文は書き換えない（整形のノイズだけ落とす）
2. **wiki を検索して、4つに振り分ける**
   - **New** — 新しい記事を作る
   - **Update** — 既存の記事に足す
   - **Disputed** — 既存と食い違う。両方に印を付けて相互リンクする
   - **No material** — 新しいことが無い。raw に置き、log に書いて終わる
3. **記事を書く**。同じ主張なら統合し、新しい概念なら新しい記事にする
4. **index と log を更新する**

資料が薄いときは、記事を作らずに No material で終わらせます。無理に記事にしない。

## 根拠の決まり

- 数値・日付・引用は、raw に書かれている形のまま書く（\`42K\` を \`42,000\` にしない）
- 計算した値は、材料を並べて書く（あとから raw で確かめられるように）
- raw に見つからない値は、正確な形では書かない。落とすか、精度を落として書く
- 記事には、根拠にした raw のファイルをリンクで並べる

## 答える（Query）

- wiki を検索して、記事へのリンク付きで答える
- wiki に無いことは「無い」と言う。raw を読み直して答えるのはよいが、そのあと wiki に足す
- 出典のない断定をしない

## 点検する（Lint）

- \`index.md\` に載っていない記事、リンク切れ、更新日が古い記事
- 根拠が raw に無い記述
- 直せるものは直し、直せないものは一覧にして報告する

## やらないこと

- raw を書き換える・消す（原典は動かさない）
- 資料が薄いのに記事を作る
- 出典のない断定を書く
- 話題の下にさらにフォルダを重ねる

## 出典

- [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki)（MIT）
- [Karpathy の LLM Wiki（gist）](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
`;
