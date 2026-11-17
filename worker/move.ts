// ファイルとフォルダの移動。blob や tree をそのまま付け替える（tree_edit.ts）。
// フォルダは、コミットする時点の中身（tree）を丸ごと付け替える。直前に中のファイルが書き換えられていても、その変更ごと移る
// （読んだときの版を突き合わせる必要がない）。中のファイルの数に関係なく1回のコミットになる。
import { ApiError, editTree, isEditablePath, readJsonRequest } from "./tree_edit";
import type { Repo } from "./proxy";

export type MoveRequest =
  | { source: string; destination: string; baseSha: string; folder?: false }
  | { source: string; destination: string; folder: true };

/** 移動できる場所の決まりは tree_edit.ts の isEditablePath（削除と同じ） */
export const isMovablePath = isEditablePath;

export function parseMoveRequest(body: unknown): MoveRequest | null {
  if (!body || typeof body !== "object") return null;
  const { source, destination, baseSha, folder } = body as Record<string, unknown>;
  if (typeof source !== "string" || typeof destination !== "string" ||
    !isEditablePath(source) || !isEditablePath(destination) || source === destination ||
    destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`)) return null;
  if (folder === true) return { source, destination, folder: true };
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) return null;
  return { source, destination, baseSha };
}

export function moveFile(token: string, repo: Repo, branch: string, move: MoveRequest): Promise<boolean> {
  return editTree(token, repo, branch, [move.source, move.destination], ([source, destination]) => {
    if (move.folder) {
      if (!source || source === "blocked" || source.type !== "tree" || destination !== null) return null;
      return {
        message: `Rootlore: Move ${move.source}/ → ${move.destination}/`,
        changes: [
          { path: move.source, mode: "040000", type: "tree", sha: null },
          { path: move.destination, mode: "040000", type: "tree", sha: source.sha },
        ],
      };
    }
    if (!source || source === "blocked" || source.type !== "blob" || source.sha !== move.baseSha || destination !== null) return null;
    return {
      message: `Rootlore: Move ${move.source} → ${move.destination}`,
      changes: [
        { path: move.source, mode: source.mode, type: "blob", sha: null },
        { path: move.destination, mode: source.mode, type: "blob", sha: source.sha },
      ],
    };
  });
}

export async function handleMove(request: Request, token: string, repo: Repo, branch: string): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const read = await readJsonRequest(request);
  if (read instanceof Response) return read;
  const move = parseMoveRequest(read.body);
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
