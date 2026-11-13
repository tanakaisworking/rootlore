// vault-web: 最初の画面（ホーム）の中身。最近のコミットと、そこで変わったノート、
// 草のグラフとグロースグラフの元（/stats/commit_activity）を GitHub から取る。
// ホームのページがないとき、content_manager.ts が vaultWebHome() を呼ぶ。画面は
// components/vault_web_home_view.tsx が、ここに残した中身（homeState）から描く（本文は隠す）。
// 戻す Markdown は、ページの中身（隠れている本文）にする。
// Lua（virtualPage）にしないのは、初回は索引が終わるまで Lua が読み込まれず、数分のあいだ「見つかりません」になるため。

import { githubApiFetch } from "./vault_web_fetch.ts";
import { t } from "./vault_web_i18n.ts";
import type { ActivityWeek } from "./vault_web_activity.ts";
import {
  buildGrowth,
  type CommitRef,
  folderSizes,
  type Growth,
  pickSnapshots,
  type Snapshot,
  type TreeEntry,
} from "./vault_web_growth.ts";

type Repo = { owner: string; repo: string; branch: string };

type CommitSummary = {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
};

export type CommitDetail = CommitSummary & {
  files?: { filename: string; status: string; previous_filename?: string }[];
};

const COMMITS = 5;
export const FILES_PER_COMMIT = 12;

export const statusLabel: Record<string, string> = {
  added: t("追加", "added"),
  modified: t("変更", "modified"),
  changed: t("変更", "modified"),
  removed: t("削除", "deleted"),
  renamed: t("名前の変更", "renamed"),
  copied: t("複製", "copied"),
};

export const dateFormat = new Intl.DateTimeFormat(t("ja-JP", "en-US"), {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const recentUpdates = () => t("最近の更新", "Recent updates");

/** 「（変更）」。英語では「 (modified)」 */
const paren = (label: string) => t(`（${label}）`, ` (${label})`);

/** コミットのメッセージなど、vault の外から来た文字を Markdown として解釈させない */
export function escapeInline(text: string): string {
  return text.replace(/[\\`*[\]<>~]/g, (ch) => `\\${ch}`);
}

function noteLine(file: NonNullable<CommitDetail["files"]>[number]): string {
  const name = file.filename.replace(/\.md$/, "");
  const label = statusLabel[file.status] ?? file.status;
  const slash = name.lastIndexOf("/");
  const base = name.slice(slash + 1);
  const folder = slash >= 0 ? ` · ${escapeInline(name.slice(0, slash))}` : "";
  if (file.status === "removed") {
    return `- ~~${escapeInline(base)}~~${paren(label)}${folder}`;
  }
  return `- [[${name}|${base}]]${paren(label)}${folder}`;
}

export function renderHome(commits: CommitDetail[]): string {
  // ノートの件数は出さない（端末の一覧は同期の途中だと少なく見え、誤解させるため）
  const lines = [`## ${recentUpdates()}`, ""];
  if (commits.length === 0) {
    lines.push(t("更新履歴はまだありません。", "No updates yet."));
  }
  for (const c of commits) {
    const title =
      c.commit.message.split("\n")[0]!.trim() || t("（コメントなし）", "(no message)");
    const when = c.commit.author?.date
      ? dateFormat.format(new Date(c.commit.author.date))
      : "";
    lines.push(`### ${escapeInline(title)}`);
    lines.push(`${when}${c.commit.author?.name ? ` · ${escapeInline(c.commit.author.name)}` : ""}`);
    lines.push("");
    // 詳細は FILES_PER_COMMIT + 1 件だけ取る（差分が大きいコミットで重くならないように）
    const files = (c.files ?? []).slice(0, FILES_PER_COMMIT);
    const more = (c.files?.length ?? 0) > FILES_PER_COMMIT;
    const notes = files.filter((f) => f.filename.endsWith(".md"));
    for (const f of notes) lines.push(noteLine(f));
    const others = files.length - notes.length;
    if (others > 0 || more) {
      const parts = [];
      if (others > 0) {
        parts.push(t(`ノート以外のファイル ${others}件`, `${others} other ${others === 1 ? "file" : "files"}`));
      }
      if (more) parts.push(t("ほかの変更は省略", "more changes not shown"));
      lines.push(`- ${parts.join(t("、", ", "))}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// --- 画面に渡す中身 ---

export type HomeState = {
  /** 最近のコミット。取れなかったら null、取る前は undefined */
  commits?: CommitDetail[] | null;
  /** 過去1年の週ごとの数。GitHub が集計中なら "pending"、取れなかったら null */
  activity?: ActivityWeek[] | "pending" | null;
  /** フォルダごとのノートの量の移り変わり。取れなかったら null */
  growth?: Growth | null;
  /** ホームを読み込み直すたび、索引ができたときに増える（知識マップを作り直す） */
  version: number;
};

let homeState: HomeState = { version: 0 };
const listeners = new Set<() => void>();

export function getHomeState(): HomeState {
  return homeState;
}

export function subscribeHome(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setHomeState(patch: Partial<HomeState>) {
  homeState = { ...homeState, ...patch };
  for (const listener of listeners) listener();
}

/** 索引ができた（client.ts）。知識マップを作り直す */
export function notifyIndexReady() {
  setHomeState({ version: homeState.version + 1 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GitHub は初めて頼まれたとき 202 を返して集計を始める。少し待って3回まで頼み直す。
 * ホームを開くのを待たせないよう、vaultWebHome() は待たずに続ける
 */
async function loadActivity(apiBase: string, base: string) {
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(2000);
      const res = await githubApiFetch(apiBase, `${base}/stats/commit_activity`);
      if (res.status === 202) continue;
      if (res.status === 204) return setHomeState({ activity: [] });
      if (!res.ok) throw new Error(`commit_activity: ${res.status}`);
      return setHomeState({ activity: (await res.json()) as ActivityWeek[] });
    }
    setHomeState({ activity: "pending" });
  } catch (e) {
    console.error("[vault-web] home activity", e);
    setHomeState({ activity: null });
  }
}

/** コミットの一覧を読む上限（100件ずつ）。これより古いコミットは「成長の記録」に入れない */
const GROWTH_COMMIT_PAGES = 10;
/** 「成長の記録」の時点の数の上限（ファイルの一覧を読む回数） */
const GROWTH_POINTS = 60;
/** 色を分けて出すフォルダの数。ほかは「その他」 */
const GROWTH_FOLDERS = 6;

let growthLoading = false;

async function loadGrowth(apiBase: string, base: string, branch: string) {
  if (growthLoading) return;
  growthLoading = true;
  try {
    const commits: CommitRef[] = [];
    for (let page = 1; page <= GROWTH_COMMIT_PAGES; page++) {
      const res = await githubApiFetch(
        apiBase,
        `${base}/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=${page}`,
      );
      if (!res.ok) throw new Error(`commits: ${res.status}`);
      const list = (await res.json()) as {
        commit: { committer: { date: string } | null; tree: { sha: string } };
      }[];
      for (const c of list) {
        if (c.commit.committer) {
          commits.push({ date: c.commit.committer.date, tree: c.commit.tree.sha });
        }
      }
      if (list.length < 100) break;
    }
    const picked = pickSnapshots(commits, GROWTH_POINTS);
    // ファイルの一覧は SHA で決まるので、ブラウザのキャッシュを使ってよい。大きいので3つずつ読む
    const snapshots: Snapshot[] = new Array(picked.length);
    let next = 0;
    const worker = async () => {
      while (next < picked.length) {
        const i = next++;
        const res = await githubApiFetch(
          apiBase,
          `${base}/git/trees/${picked[i]!.tree}?recursive=1`,
          { cache: "default" },
        );
        if (!res.ok) throw new Error(`tree: ${res.status}`);
        const tree = (await res.json()) as { tree: TreeEntry[] };
        snapshots[i] = { time: Date.parse(picked[i]!.date), folders: folderSizes(tree.tree) };
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setHomeState({ growth: buildGrowth(snapshots, GROWTH_FOLDERS) });
  } catch (e) {
    console.error("[vault-web] home growth", e);
    setHomeState({ growth: null });
  } finally {
    growthLoading = false;
  }
}

export function registerVaultWebHome(apiBase: string, repo: Repo & { disconnected?: boolean }) {
  const base = `/repos/${repo.owner}/${repo.repo}`;
  (globalThis as any).vaultWebHome = async (): Promise<string> => {
    // まだ GitHub に繋いでいなければ、繋ぎ方を案内する（ノートは無い）
    if (repo.disconnected) {
      setHomeState({ commits: [], activity: [], growth: null });
      return `## ${t("GitHubに接続", "Connect to GitHub")}

${t(
  "まだノートのリポジトリに接続していません。左のサイドバーの下にあるアカウントのページから接続してください。",
  "You haven't connected a notes repository yet. Connect one from the account page at the bottom of the sidebar.",
)}`;
    }
    setHomeState({ version: homeState.version + 1 });
    void loadActivity(apiBase, base);
    void loadGrowth(apiBase, base, repo.branch);
    try {
      const res = await githubApiFetch(
        apiBase,
        `${base}/commits?sha=${encodeURIComponent(repo.branch)}&per_page=${COMMITS}`,
      );
      if (!res.ok) throw new Error(`commits: ${res.status}`);
      const list = (await res.json()) as CommitSummary[];
      // 1件ずつの詳細は SHA で決まるので、ブラウザのキャッシュを使ってよい
      const details = await Promise.all(
        list.map(async (c) => {
          const r = await githubApiFetch(
            apiBase,
            `${base}/commits/${c.sha}?per_page=${FILES_PER_COMMIT + 1}`,
            { cache: "default" },
          );
          return r.ok ? ((await r.json()) as CommitDetail) : c;
        }),
      );
      setHomeState({ commits: details });
      return renderHome(details);
    } catch (e) {
      console.error("[vault-web] home", e);
      setHomeState({ commits: null });
      return `## ${recentUpdates()}\n\n${t(
        "更新履歴を取得できませんでした。サイドバーの「最新の状態に更新」から再度お試しください。",
        "Couldn't load recent updates. Try again with Refresh from GitHub in the sidebar.",
      )}`;
    }
  };
}
