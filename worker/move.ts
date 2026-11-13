// blobをそのまま付け替える。本文の取得や再アップロードをせず、画像や実行属性も保つ。
import { githubHeaders } from "./github";
import type { Repo } from "./proxy";

export type MoveRequest = { source: string; destination: string; baseSha: string };
type Entry = { path: string; sha: string; mode: string; type: string };

export function isMovablePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("Library/Std/") &&
    !/[\\:\u0000-\u001f\u007f]/.test(path) && path.split("/").every((p) => p.length > 0 && !p.startsWith("."));
}

export function parseMoveRequest(body: unknown): MoveRequest | null {
  if (!body || typeof body !== "object") return null;
  const { source, destination, baseSha } = body as Record<string, unknown>;
  if (typeof source !== "string" || typeof destination !== "string" ||
    !isMovablePath(source) || !isMovablePath(destination) || source === destination ||
    destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`) ||
    typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) return null;
  return { source, destination, baseSha };
}

class ApiError extends Error {
  constructor(readonly status: number) { super(`GitHub move: HTTP ${status}`); }
}

export async function moveFile(token: string, repo: Repo, branch: string, move: MoveRequest): Promise<boolean> {
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
    async function entry(path: string): Promise<Entry | null | "blocked"> {
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
    const source = await entry(move.source);
    const destination = await entry(move.destination);
    if (!source || source === "blocked" || source.type !== "blob" || source.sha !== move.baseSha || destination !== null) return false;
    const tree = await api("/trees", "POST", {
      base_tree: root,
      tree: [
        { path: move.source, mode: source.mode, type: "blob", sha: null },
        { path: move.destination, mode: source.mode, type: "blob", sha: source.sha },
      ],
    });
    const next = await api("/commits", "POST", {
      message: `Rootlore: Move ${move.source} → ${move.destination}`,
      tree: tree.sha,
      parents: [oid],
    });
    try {
      // force:falseのfast-forward検査で、確認後に入ったコミットを上書きしない。
      await api(refPath, "PATCH", { sha: next.sha, force: false });
      return true;
    } catch (e) {
      if (!(e instanceof ApiError) || ![409, 422].includes(e.status)) throw e;
      if (await head() === oid) throw e;
      // 別ファイルの更新なら取り込んで再試行。移動元や先が変われば次の検査で止まる。
    }
  }
  return false;
}

export async function handleMove(request: Request, token: string, repo: Repo, branch: string): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers });
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return new Response("Unsupported Media Type", { status: 415, headers });
  }
  const text = await request.text();
  if (text.length > 4096) return new Response("Bad Request", { status: 400, headers });
  let move: MoveRequest | null;
  try { move = parseMoveRequest(JSON.parse(text)); } catch { move = null; }
  if (!move) return new Response("Bad Request", { status: 400, headers });
  try {
    return await moveFile(token, repo, branch, move)
      ? Response.json({ moved: true }, { headers })
      : Response.json({ error: "conflict" }, { status: 409, headers });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return Response.json({ error: "refresh" }, { status: 401, headers });
    throw e;
  }
}
