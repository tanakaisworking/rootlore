// CLI の書き込み（write・append・resolve）を、1回のコミットにまとめて GitHub に送る。
//
// 受け取るのは、ファイルごとに「パス・本文（base64）・読んだときの blob SHA（baseSha）」だけ。
// GitHub 側でそのファイルが baseSha から変わっていれば、何もコミットせずに 409 で今の SHA を返す
// （CLI が3方向でまとめて、もう一度送る。まとまらなければ、食い違いの写しとして別に残す）。
// 消せるのは食い違いの写し（ノート名.conflicted-日時.md）だけ。ほかのノートは消さない。
// GraphQL の query はすべてここで組み立て、パスや本文は変数で渡す。

import { githubHeaders } from "./github";
import type { Repo } from "./proxy";

const API = "https://api.github.com";
const GRAPHQL = `${API}/graphql`;

/** 1回で保存できるファイルの数と大きさ */
export const MAX_FILES = 100;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_TOTAL_BYTES = 10 * 1_048_576;
const MAX_MESSAGE = 200;
const MAX_ATTEMPTS = 3;

export type CommitFile = { path: string; content: string; baseSha: string | null };
/** symlink。target はリポジトリの根からの相対パス（スキルの写しだけに使う） */
export type CommitLink = { path: string; target: string; baseSha: string | null };
export type CommitDeletion = { path: string; baseSha: string };
export type CommitRequest = {
  files: CommitFile[];
  /** スキルの写し（symlink）。省略したときは空 */
  symlinks?: CommitLink[];
  deletions: CommitDeletion[];
  message?: string;
};
export type Conflict = { path: string; sha: string | null };

/** スキルの id（Agent Skills の name と同じ形。小文字・数字・ハイフン） */
const SKILL_ID = "[a-z0-9]+(?:-[a-z0-9]+)*";

/**
 * スキルの本体。`.claude/skills/<id>/SKILL.md` だけ、隠しフォルダの例外として書ける。
 * エージェントがリポジトリで作業したときに、そのまま読む場所
 */
export function isSkillPath(path: string): boolean {
  return new RegExp(`^\\.claude/skills/${SKILL_ID}/SKILL\\.md$`).test(path);
}

/** スキルの写し。Codex は `.agents/skills` を読むので、そこに symlink を1本だけ置く */
export function isSkillLinkPath(path: string): boolean {
  return new RegExp(`^\\.agents/skills/${SKILL_ID}$`).test(path);
}

/** symlink の指す先。同じ id の `.claude/skills/<id>` だけを許す（ほかの場所は指せない） */
export function isSkillLinkTarget(path: string, target: string): boolean {
  return target === `../../.claude/skills/${path.split("/").pop()}`;
}

/** Rootlore が書いてよいパスか。Markdown のノートだけで、隠しフォルダと同梱の標準ライブラリは除く */
export function isWritablePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (!path.endsWith(".md") || path.startsWith("Library/Std/")) return false;
  if (/[\\:\u0000-\u001f\u007f]/.test(path)) return false;
  if (isSkillPath(path)) return true;
  return path.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

/** 食い違いの写し（CLI が作る「ノート名.conflicted-20261104-153000.md」）か */
export function isConflictCopy(path: string): boolean {
  return isWritablePath(path) && /\.conflicted-[0-9-]+\.md$/.test(path);
}

function base64Bytes(content: string): number | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) return null;
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return (content.length / 4) * 3 - padding;
}

const isSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

/** 受け取った本文を確かめる。だめなら null */
export function parseCommitRequest(body: unknown): CommitRequest | null {
  if (!body || typeof body !== "object") return null;
  const { files, symlinks = [], deletions = [], message } = body as { files?: unknown; symlinks?: unknown; deletions?: unknown; message?: unknown };
  if (!Array.isArray(files) || !Array.isArray(symlinks) || !Array.isArray(deletions)) return null;
  if (files.length === 0 || files.length + symlinks.length + deletions.length > MAX_FILES) return null;
  if (message !== undefined) {
    if (typeof message !== "string" || message.trim().length === 0 || message.length > MAX_MESSAGE) return null;
    if (/[\u0000-\u001f\u007f]/.test(message)) return null;
  }
  const seen = new Set<string>();
  let total = 0;
  const parsed: CommitFile[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") return null;
    const { path, content, baseSha } = file as Record<string, unknown>;
    if (typeof path !== "string" || !isWritablePath(path) || seen.has(path)) return null;
    if (typeof content !== "string") return null;
    if (baseSha !== null && !isSha(baseSha)) return null;
    const bytes = base64Bytes(content);
    if (bytes === null || bytes > MAX_FILE_BYTES) return null;
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return null;
    seen.add(path);
    parsed.push({ path, content, baseSha });
  }
  const parsedLinks: CommitLink[] = [];
  for (const link of symlinks) {
    if (!link || typeof link !== "object") return null;
    const { path, target, baseSha } = link as Record<string, unknown>;
    if (typeof path !== "string" || !isSkillLinkPath(path) || seen.has(path)) return null;
    if (typeof target !== "string" || !isSkillLinkTarget(path, target)) return null;
    if (baseSha !== null && !isSha(baseSha)) return null;
    seen.add(path);
    parsedLinks.push({ path, target, baseSha });
  }
  const parsedDeletions: CommitDeletion[] = [];
  for (const deletion of deletions) {
    if (!deletion || typeof deletion !== "object") return null;
    const { path, baseSha } = deletion as Record<string, unknown>;
    if (typeof path !== "string" || !isConflictCopy(path) || seen.has(path) || !isSha(baseSha)) return null;
    seen.add(path);
    parsedDeletions.push({ path, baseSha });
  }
  return {
    files: parsed,
    symlinks: parsedLinks,
    deletions: parsedDeletions,
    ...(message !== undefined ? { message: message.trim() } : {}),
  };
}

/** コミットメッセージ。例「Rootlore: 買い物メモ ほか2件」 */
export function commitHeadline(paths: string[]): string {
  const name = paths[0]!.split("/").pop()!.replace(/\.md$/, "");
  return paths.length > 1 ? `Rootlore: ${name} ほか${paths.length - 1}件` : `Rootlore: ${name}`;
}

type Gql = { query: string; variables: Record<string, unknown> };
type GqlError = { message: string; type?: string; path?: unknown[] };
type GqlResult = { data?: any; errors?: GqlError[] };

class GitHubUnauthorized extends Error {}

async function graphql(token: string, body: Gql): Promise<GqlResult> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new GitHubUnauthorized();
  if (!res.ok) throw new Error(`GitHub GraphQL: ${res.status}`);
  return (await res.json()) as GqlResult;
}

function pathVariables(paths: string[]) {
  const declarations = paths.map((_, i) => `$p${i}: String!`).join(", ");
  const fields = paths.map((_, i) => `f${i}: file(path: $p${i}) { oid type }`).join("\n");
  const values = Object.fromEntries(paths.map((path, i) => [`p${i}`, path]));
  return { declarations, fields, values };
}

/** 確かめるパス。書くファイルが先、消す写しがあと（返事の f0, f1… はこの順） */
function allPaths(request: CommitRequest): string[] {
  return [
    ...request.files.map((file) => file.path),
    ...(request.symlinks ?? []).map((link) => link.path),
    ...request.deletions.map((deletion) => deletion.path),
  ];
}

/** allPaths と同じ順の baseSha */
function allBases(request: CommitRequest): (string | null)[] {
  return [
    ...request.files.map((file) => file.baseSha),
    ...(request.symlinks ?? []).map((link) => link.baseSha),
    ...request.deletions.map((deletion) => deletion.baseSha),
  ];
}

/** ブランチの先頭のコミットと、そこでの各ファイルの blob SHA を、同じ時点で取る */
export function headQuery({ owner, repo }: Repo, branch: string, paths: string[]): Gql {
  const { declarations, fields, values } = pathVariables(paths);
  return {
    query: `query($owner: String!, $name: String!, $ref: String!, ${declarations}) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { oid ... on Commit {\n${fields}\n} } }
  }
}`,
    variables: { owner, name: repo, ref: `refs/heads/${branch}`, ...values },
  };
}

export function commitMutation({ owner, repo }: Repo, branch: string, headOid: string, request: CommitRequest): Gql {
  const paths = request.files.map((file) => file.path);
  return {
    // 書いたファイルの版は、ここでは聞かない（送った本文から計算する。gitBlobSha）
    query: `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
        expectedHeadOid: headOid,
        message: { headline: request.message ?? commitHeadline(paths), body: allPaths(request).join("\n") },
        fileChanges: {
          additions: request.files.map((file) => ({ path: file.path, contents: file.content })),
          ...(request.deletions.length ? { deletions: request.deletions.map((d) => ({ path: d.path })) } : {}),
        },
      },
    },
  };
}

type Entry = { oid: string; type: string } | null;

/** Git の blob SHA（"blob <長さ>\0" と中身の SHA-1）。content は base64 */
export async function gitBlobSha(content: string): Promise<string> {
  const data = Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0));
  const header = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(header.length + data.length);
  all.set(header);
  all.set(data, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * GitHub は、まだないファイルの欄を null にし、その欄を指した NOT_FOUND のエラーを付ける。
 * それだけなら「ない」と分かる。ほかのエラーがあれば、取れなかった欄と見分けがつかないので null を返す
 */
function missingFields(errors: GqlError[] | undefined, count: number): Set<string> | null {
  const missing = new Set<string>();
  for (const error of errors ?? []) {
    const path = error.path ?? [];
    const field = path[3];
    const fieldIndex = typeof field === "string" && /^f\d+$/.test(field) ? Number(field.slice(1)) : -1;
    const pointsAtField =
      path.length === 4 && path[0] === "repository" && path[1] === "ref" && path[2] === "target" && fieldIndex >= 0 && fieldIndex < count;
    if (error.type !== "NOT_FOUND" || !pointsAtField) return null;
    missing.add(field as string);
  }
  return missing;
}

export type CommitOutcome =
  | { status: "committed"; commit: string; files: { path: string; sha: string }[] }
  | { status: "conflict"; conflicts: Conflict[] };

type HeadCheck = { status: "conflict"; conflicts: Conflict[] } | { status: "ok"; headOid: string };

/** ブランチの先頭と、書く（消す）パスの今の blob SHA を取る。baseSha と違えば食い違い */
async function checkHead(token: string, repo: Repo, branch: string, request: CommitRequest): Promise<HeadCheck> {
  const paths = allPaths(request);
  const bases = allBases(request);
  const head = await graphql(token, headQuery(repo, branch, paths));
  const target = head.data?.repository?.ref?.target as (Record<string, Entry> & { oid?: string }) | undefined;
  if (!target?.oid) throw new Error(`GitHub: branch not found (${head.errors?.[0]?.message ?? "no ref"})`);
  // GraphQL は、エラーと一部だけの結果を一緒に返すことがある。取れなかったファイルは null になり、
  // 「GitHub にない」と見分けがつかない（新しいノートなら、GitHub の本文を上書きしてしまう）。全部取れたときだけ比べる
  const missing = missingFields(head.errors, paths.length);
  if (!missing) throw new Error(`GitHub: ${head.errors![0]!.message}`);
  const conflicts: Conflict[] = [];
  paths.forEach((path, i) => {
    if (!(`f${i}` in target)) throw new Error(`GitHub: ${path} was not returned`);
    const entry = target[`f${i}`] ?? null;
    // null なのに「ない」のエラーがない欄は、取れなかったのかもしれない
    if (!entry && !missing.has(`f${i}`)) throw new Error(`GitHub: ${path} came back empty`);
    if (entry && missing.has(`f${i}`)) throw new Error(`GitHub: ${path} came back both found and missing`);
    if (entry && entry.type !== "blob") throw new Error(`GitHub: ${path} is not a file`);
    const current = entry?.oid ?? null;
    if (current !== bases[i]) conflicts.push({ path, sha: current });
  });
  return conflicts.length ? { status: "conflict", conflicts } : { status: "ok", headOid: target.oid };
}

/** 保存する。GitHub が断った（パスがフォルダ、など）ときは例外 */
export async function commitFiles(token: string, repo: Repo, branch: string, request: CommitRequest): Promise<CommitOutcome> {
  // symlink を含むときだけ、別の道（GraphQL の createCommitOnBranch は symlink を作れない）
  if ((request.symlinks ?? []).length > 0) return commitWithLinks(token, repo, branch, request);
  for (let attempt = 1; ; attempt++) {
    const check = await checkHead(token, repo, branch, request);
    if (check.status === "conflict") return check;
    const result = await graphql(token, commitMutation(repo, branch, check.headOid, request));
    const commit = result.data?.createCommitOnBranch?.commit as { oid?: string } | undefined;
    // コミットができていれば、ほかの欄にエラーが付いていても成功（失敗と返すと、足し直して二重になる）
    if (commit?.oid) {
      return {
        status: "committed",
        commit: commit.oid,
        files: await Promise.all(request.files.map(async (file) => ({ path: file.path, sha: await gitBlobSha(file.content) }))),
      };
    }
    const message = result.errors?.[0]?.message ?? "no commit";
    // 確かめてからコミットするまでの間に、誰か（AI の push など）がブランチを進めた。確かめ直す
    if (attempt < MAX_ATTEMPTS && /expected branch to point to/i.test(message)) continue;
    throw new Error(`GitHub: ${message}`);
  }
}

async function rest<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...githubHeaders(token),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new GitHubUnauthorized();
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status}`);
  return (await res.json()) as T;
}

function base64Of(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * ブランチを進める。force を付けないので、早送りでなければ GitHub が断る
 * （確かめてから進めるまでの間に、誰かがブランチを進めた）
 */
async function moveRef(token: string, repoPath: string, branch: string, sha: string): Promise<"ok" | "moved"> {
  const path = `${repoPath}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(`${API}${path}`, {
    method: "PATCH",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ sha, force: false }),
  });
  if (res.status === 401) throw new GitHubUnauthorized();
  if (res.status === 422) return "moved";
  if (!res.ok) throw new Error(`GitHub: could not move the branch (${res.status})`);
  return "ok";
}

/**
 * symlink を1本だけ作る道。Git Data API は mode を指定できるので、120000（symlink）を置ける。
 * 先頭のコミットを取って、blob → tree → commit → ref の順に進める。使うのはスキルの追加だけ
 */
async function commitWithLinks(token: string, repo: Repo, branch: string, request: CommitRequest): Promise<CommitOutcome> {
  const repoPath = `/repos/${repo.owner}/${repo.repo}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const check = await checkHead(token, repo, branch, request);
    if (check.status === "conflict") return check;
    const head = await rest<{ tree: { sha: string } }>(token, "GET", `${repoPath}/git/commits/${check.headOid}`);
    const tree: { path: string; mode: string; type: "blob"; sha: string }[] = [];
    for (const file of request.files) {
      const blob = await rest<{ sha: string }>(token, "POST", `${repoPath}/git/blobs`, {
        content: file.content,
        encoding: "base64",
      });
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const link of request.symlinks ?? []) {
      const blob = await rest<{ sha: string }>(token, "POST", `${repoPath}/git/blobs`, {
        content: base64Of(link.target),
        encoding: "base64",
      });
      tree.push({ path: link.path, mode: "120000", type: "blob", sha: blob.sha });
    }
    const newTree = await rest<{ sha: string }>(token, "POST", `${repoPath}/git/trees`, {
      base_tree: head.tree.sha,
      tree,
    });
    const headline = request.message ?? commitHeadline(request.files.map((file) => file.path));
    const commit = await rest<{ sha: string }>(token, "POST", `${repoPath}/git/commits`, {
      message: `${headline}\n\n${allPaths(request).join("\n")}`,
      tree: newTree.sha,
      parents: [check.headOid],
    });
    if ((await moveRef(token, repoPath, branch, commit.sha)) === "moved") continue;
    return {
      status: "committed",
      commit: commit.sha,
      files: await Promise.all(
        request.files.map(async (file) => ({ path: file.path, sha: await gitBlobSha(file.content) })),
      ),
    };
  }
  throw new Error("GitHub: the branch kept moving");
}

export async function handleCommit(request: Request, token: string, repo: Repo, branch: string): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" };
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  // ほかのサイトのフォームからは送れないようにする（JSON の Content-Type は、フォームでは付けられない）
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const parsed = parseCommitRequest(body);
  if (!parsed) return new Response("Bad Request", { status: 400 });
  try {
    const outcome = await commitFiles(token, repo, branch, parsed);
    return outcome.status === "conflict"
      ? Response.json({ conflicts: outcome.conflicts }, { status: 409, headers: noStore })
      : Response.json({ commit: outcome.commit, files: outcome.files }, { headers: noStore });
  } catch (e) {
    if (e instanceof GitHubUnauthorized) return Response.json({ error: "refresh" }, { status: 401, headers: noStore });
    throw e;
  }
}
