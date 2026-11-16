// GitHub のファイルの並び（ツリー）を、確かめてから1回のコミットで書き換える。移動（move.ts）と削除（delete.ts）が使う。
// 本文の取得や再アップロードはせず、blob をそのまま付け替える（画像や実行属性も保つ）。
// 確かめた後に別のコミットが入ったら、それを取り込んでやり直す（force:false の fast-forward で上書きしない）。
import { githubHeaders } from "./github";
import type { Repo } from "./proxy";

export type Entry = { path: string; sha: string; mode: string; type: string };
/** そのパスの今の状態。無ければ null、途中がファイルで辿れなければ "blocked" */
export type Found = Entry | null | "blocked";
export type TreeChange = { path: string; mode: string; type: "blob"; sha: string | null };
/** 今の状態を見て、書き換える中身を決める。書き換えてはいけなければ null */
export type Plan = (found: Found[]) => { changes: TreeChange[]; message: string } | null;

export class ApiError extends Error {
  constructor(readonly status: number) { super(`GitHub tree edit: HTTP ${status}`); }
}

export function isEditablePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("Library/Std/") &&
    !/[\\:\u0000-\u001f\u007f]/.test(path) && path.split("/").every((p) => p.length > 0 && !p.startsWith("."));
}

export async function editTree(token: string, repo: Repo, branch: string, paths: string[], plan: Plan): Promise<boolean> {
  const base = `https://api.github.com/repos/${repo.owner}/${repo.repo}/git`;
  async function api(path: string, method = "GET", body?: unknown): Promise<any> {
    const res = await fetch(base + path, {
      method,
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new ApiError(res.status);
    return res.json();
  }
  const refPath = `/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const head = async (): Promise<string> => {
    const data = await api(refPath.replace("/refs/", "/ref/"));
    if (!/^[a-f0-9]{40}$/.test(data.object?.sha)) throw new Error("GitHub: no branch head");
    return data.object.sha;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const oid = await head();
    const commit = await api(`/commits/${oid}`);
    const root = commit.tree?.sha;
    if (typeof root !== "string") throw new Error("GitHub: no commit tree");
    const trees = new Map<string, Entry[]>();
    async function entry(path: string): Promise<Found> {
      const parts = path.split("/");
      let sha = root;
      for (let i = 0; i < parts.length; i++) {
        if (!trees.has(sha)) {
          const tree = await api(`/trees/${sha}`);
          if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("GitHub: incomplete tree");
          trees.set(sha, tree.tree);
        }
        const found = trees.get(sha)!.find((e) => e.path === parts[i]);
        if (!found) return null;
        if (i === parts.length - 1) return found;
        if (found.type !== "tree") return "blocked";
        sha = found.sha;
      }
      return null;
    }
    const found: Found[] = [];
    for (const path of paths) found.push(await entry(path));
    const decided = plan(found);
    if (!decided) return false;
    const tree = await api("/trees", "POST", { base_tree: root, tree: decided.changes });
    const next = await api("/commits", "POST", { message: decided.message, tree: tree.sha, parents: [oid] });
    try {
      await api(refPath, "PATCH", { sha: next.sha, force: false });
      return true;
    } catch (e) {
      if (!(e instanceof ApiError) || ![409, 422].includes(e.status)) throw e;
      if (await head() === oid) throw e;
      // 別ファイルの更新なら取り込んで再試行。対象が変われば次の plan で止まる。
    }
  }
  return false;
}

/** JSON を受け取る口の共通の入口（移動と削除）。読めない中身は body: null */
export async function readJsonRequest(request: Request): Promise<{ body: unknown } | Response> {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers });
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return new Response("Unsupported Media Type", { status: 415, headers });
  }
  const text = await request.text();
  if (text.length > 4096) return new Response("Bad Request", { status: 400, headers });
  try { return { body: JSON.parse(text) }; } catch { return { body: null }; }
}
