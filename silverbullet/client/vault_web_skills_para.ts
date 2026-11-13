// vault-web: 内蔵カタログの PARA。Tiago Forte の整理法を、Vault を整理する手順書として書き直したもの。
// 出典: https://fortelabs.co/blog/para/
// 中身を直すときは、この文字列をそのまま書き換える（インストール済みの Vault には反映されない）。
export const PARA_SKILL = `---
name: para
description: ノートを PARA（Projects・Areas・Resources・Archive）で分類し、置き場所を決める。ノートの棚卸し、Inbox の処理、Archive へ移すかの判断、どこに置くか迷ったときに使う。
metadata:
  source: https://fortelabs.co/blog/para/
---

# PARA でノートを整理する

PARA は Tiago Forte の整理法です。分けるときの基準は「話題」ではなく「いまの行動との距離」です。
学校の科目のように分類すると、必要なときに探せません。いま進めていることから近い順に置きます。

## 4つの箱

| 箱 | 何が入るか | 終わり |
|---|---|---|
| Projects | ゴールのある短い取り組み | ある |
| Areas | 続いていく責任 | ない |
| Resources | 参照するための知識 | 決めない |
| Archive | 終わった・止めた・使わないもの | 済み |

- **Projects** は「終わったと言える」ものだけ。終わりが言えないなら Areas
- **Areas** は「採用」「健康」「経理」のような、続く責任
- **Resources** は「いつか使うかもしれない」知識。行動の圧力がない
- **Archive** は捨てる場所ではない。終わったものを残しておく場所

## 判断の順番

1. frontmatter に \`para_type\` があれば、それを優先する
2. いまの置き場所は強い手がかり。簡単には動かさない
3. ゴールと終わりがあるか → Projects
4. 終わりのない責任か → Areas
5. 参照するだけか → Resources
6. 終わった・止めた・使わない → Archive
7. 決められない → Inbox に置き、\`needs_review: true\` を付けて、理由を1行書く

迷ったまま動かすより、Inbox に残すほうが安全です。

## 印を書く

分類したら、frontmatter に \`para_type\` を足します。既存の項目は消さない・上書きしない。

\`\`\`yaml
para_type: project   # project / area / resource / archive
\`\`\`

## 動かすとき

- まず1つの箱だけを試す。全体を一度に動かさない
- \`git mv\` で動かし、履歴を残す
- 動かす前に、どこへ何を動かすかを一覧で出す
- 確認なしに削除・統合しない

## やらないこと

- 話題でフォルダを切る（PARA は行動で切る）
- Areas を Projects のまま放置する（終わりが無いのに Project にしない）
- Archive を消す（残すためにある箱）
- 全ノートに一括で印を付ける（まず1つの箱で試す）

## 出典

- [The PARA Method（Forte Labs）](https://fortelabs.co/blog/para/)
`;
