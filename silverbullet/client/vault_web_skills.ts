// vault-web: スキルのマーケットプレイス。内蔵のカタログから選んで、リポジトリの `.claude/skills/<id>/` に書き込む。
// エージェントがリポジトリで作業したときに、そのまま読む場所に置く（Web から届くのはリポジトリだけなので、プロジェクトスコープ）。
// 書き込みはノートの新規作成と同じ Worker の /api/gh/commit（baseSha: null = 新規）。既にあれば 409 で断られる。
// Codex は `.agents/skills` を読むので、そちらには symlink を1本だけ置く（中身を二重に持たない）。
// 一覧はコードに持つ（社内のスキルを勝手に取ってこないため、URL を貼って追加する形にはしていない）。
import { githubApiFetch } from "./vault_web_fetch.ts";
import { OKF_SKILL } from "./vault_web_skills_okf.ts";
import { PARA_SKILL } from "./vault_web_skills_para.ts";
import { JOHNNY_DECIMAL_SKILL } from "./vault_web_skills_johnny_decimal.ts";
import { LLM_WIKI_SKILL } from "./vault_web_skills_llm_wiki.ts";

export type SkillFile = { path: string; content: string };

/**
 * カタログの並び。`base` はノートの形をそろえる土台で、ほかと組み合わせられる。
 * `layout` は「このノートをどこに置くか」を決めるので、2つ以上入れると行き先が食い違う。
 */
export type SkillGroup = "base" | "layout";

export type Skill = {
  id: string;
  group: SkillGroup;
  name: string;
  /** カードに出す1行の説明 */
  summary: string;
  /** 何ができるか（カードに箇条書きで出す） */
  does: string[];
  source: { label: string; url: string };
  /** 追加先の下に置くファイル。path はスキルのフォルダからの相対パス */
  files: SkillFile[];
};

/** 追加先。Claude Code が読む場所で、ほかのハーネスもここを読む（OpenCode・VS Code の Local） */
export const SKILLS_DIR = ".claude/skills";

/** Codex が読む場所。ここには symlink だけを置く */
export const SKILLS_LINK_DIR = ".agents/skills";

export const SKILLS: Skill[] = [
  {
    id: "okf",
    group: "base",
    name: "OKF（Open Knowledge Format）",
    summary:
      "ノートを「1概念1ファイル」に分け、frontmatter と index.md で辿れる形に整理します。",
    does: [
      "概念ごとにファイルを分ける",
      "type・description・tags を frontmatter に書く",
      "index.md で1階層ずつ一覧できるようにする",
    ],
    source: {
      label: "GoogleCloudPlatform/open-knowledge-format",
      url: "https://github.com/GoogleCloudPlatform/open-knowledge-format",
    },
    files: [{ path: "SKILL.md", content: OKF_SKILL }],
  },
  {
    id: "para",
    group: "layout",
    name: "PARA",
    summary:
      "ノートを、話題ではなく「いまの行動」で4つの箱に分けます。",
    does: [
      "Projects・Areas・Resources・Archive に分類する",
      "迷ったら Inbox に残し、印を付ける",
      "Archive へ移すかを決める",
    ],
    source: {
      label: "Forte Labs（The PARA Method）",
      url: "https://fortelabs.co/blog/para/",
    },
    files: [{ path: "SKILL.md", content: PARA_SKILL }],
  },
  {
    id: "johnny-decimal",
    group: "layout",
    name: "Johnny.Decimal",
    summary:
      "フォルダとノートに番号を振り、番号だけで置き場所が決まる形にします。",
    does: [
      "エリア・カテゴリ・ID の番号を振る",
      "番号で索引（JDex）を作る",
      "0番台を避けて置き場所を決める",
    ],
    source: {
      label: "johnnydecimal.com",
      url: "https://johnnydecimal.com/",
    },
    files: [{ path: "SKILL.md", content: JOHNNY_DECIMAL_SKILL }],
  },
  {
    id: "llm-wiki",
    group: "layout",
    name: "LLM Wiki",
    summary:
      "資料を読み込んで、エージェントが育てる wiki を作ります。",
    does: [
      "原典を raw に溜め、wiki に知識を書く",
      "索引と更新履歴を保つ",
      "根拠が原典にあるか点検する",
    ],
    source: {
      label: "Astro-Han/karpathy-llm-wiki",
      url: "https://github.com/Astro-Han/karpathy-llm-wiki",
    },
    files: [{ path: "SKILL.md", content: LLM_WIKI_SKILL }],
  },
];

export function skillDir(id: string): string {
  return `${SKILLS_DIR}/${id}`;
}

/** 追加するファイルの Vault 上のパス */
export function skillPaths(skill: Skill): string[] {
  return skill.files.map((file) => `${skillDir(skill.id)}/${file.path}`);
}

/** Codex 用の symlink。`.agents/skills/<id>` から `.claude/skills/<id>` を指す */
export function skillLink(skill: Skill): { path: string; target: string } {
  return {
    path: `${SKILLS_LINK_DIR}/${skill.id}`,
    target: `../../${SKILLS_DIR}/${skill.id}`,
  };
}

export class SkillInstallError extends Error {}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // 大きい本文でも引数の数の上限を超えないよう、少しずつ文字にする
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * 追加済みか。隠しフォルダはノートの一覧に出ないので、ファイルの有無を GitHub に聞く
 * （Worker の /api/gh は、この形のパスだけを通す）
 */
export async function isSkillInstalled(
  apiBase: string,
  repo: { owner: string; repo: string },
  skill: Skill,
  fetchApi: typeof githubApiFetch = githubApiFetch,
): Promise<boolean> {
  const res = await fetchApi(
    apiBase,
    `/repos/${repo.owner}/${repo.repo}/contents/${skillPaths(skill)[0]}`,
    {},
    { redirectToLogin: false },
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new SkillInstallError(`HTTP ${res.status}`);
  return true;
}

/** スキルのファイルと symlink を、まとめて1コミットで追加する。既にあるファイルがあれば何も書かずに 409 */
export async function installSkill(
  apiBase: string,
  skill: Skill,
  fetchApi: typeof githubApiFetch = githubApiFetch,
): Promise<void> {
  const files = skill.files.map((file) => ({
    path: `${skillDir(skill.id)}/${file.path}`,
    content: base64(file.content),
    baseSha: null,
  }));
  const link = skillLink(skill);
  const res = await fetchApi(
    apiBase,
    "/commit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files,
        symlinks: [{ path: link.path, target: link.target, baseSha: null }],
        message: `${skill.name} スキルを追加`,
      }),
    },
    { redirectToLogin: false },
  );
  if (res.status === 409) throw new SkillInstallError("exists");
  if (res.status === 412) throw new SkillInstallError("other-repo");
  if (res.status === 401) throw new SkillInstallError("login");
  if (!res.ok) throw new SkillInstallError(`HTTP ${res.status}`);
}
