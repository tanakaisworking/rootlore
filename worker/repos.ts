// ログインした人が、どのリポジトリのノートを開くか。
// 選べるのは、その人が GitHub App を入れたリポジトリだけ（ユーザーのトークンで、App のインストール先を一覧する）。
// 選んだリポジトリはセッション（暗号化した Cookie）に入れる。サーバーには残さない。

import { githubHeaders } from "./github";

const API = "https://api.github.com";
/** 一覧に出す数の上限。「すべてのリポジトリ」に入れた人でも、画面と GitHub への問い合わせが膨らまないように */
export const MAX_REPOS = 300;
const PER_PAGE = 100;
/** App を入れた個人・組織の数の上限（GitHub の1ページの上限） */
const MAX_INSTALLATIONS = 100;

export type RepoChoice = { owner: string; repo: string; branch: string; private: boolean };

/** トークンが使えなかった（取り消された、など）。ログインし直してもらう */
export class RepoListRejected extends Error {}

async function getJson<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: githubHeaders(token) });
  if (res.status === 401) throw new RepoListRejected();
  if (!res.ok) throw new Error(`GitHub ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

type Installation = { id: number };
type GitHubRepo = { name: string; owner: { login: string }; default_branch: string; private: boolean };

export async function listInstalledRepos(token: string): Promise<RepoChoice[]> {
  const { installations } = await getJson<{ installations: Installation[] }>(
    token,
    `/user/installations?per_page=${MAX_INSTALLATIONS}`,
  );
  const found = new Map<string, RepoChoice>();
  for (const installation of installations.slice(0, MAX_INSTALLATIONS)) {
    for (let page = 1; found.size < MAX_REPOS; page++) {
      const { repositories } = await getJson<{ repositories: GitHubRepo[] }>(
        token,
        `/user/installations/${installation.id}/repositories?per_page=${PER_PAGE}&page=${page}`,
      );
      for (const r of repositories) {
        if (found.size >= MAX_REPOS) break;
        const choice = { owner: r.owner.login, repo: r.name, branch: r.default_branch, private: r.private };
        found.set(fullName(choice).toLowerCase(), choice);
      }
      if (repositories.length < PER_PAGE) break;
    }
  }
  return [...found.values()].sort((a, b) => fullName(a).localeCompare(fullName(b)));
}

export function fullName(repo: { owner: string; repo: string }): string {
  return `${repo.owner}/${repo.repo}`;
}

/** 一覧の中から、名前（owner/repo）で選ぶ。一覧にないものは選ばせない */
export function findRepo(repos: RepoChoice[], name: string): RepoChoice | undefined {
  const key = name.trim().toLowerCase();
  return repos.find((r) => fullName(r).toLowerCase() === key);
}
