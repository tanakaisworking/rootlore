// ファイルの移動。blob をそのまま付け替える（tree_edit.ts）。
import { ApiError, editTree, isEditablePath, readJsonRequest } from "./tree_edit";
import type { Repo } from "./proxy";

export type MoveRequest = { source: string; destination: string; baseSha: string };

/** 移動できる場所の決まりは tree_edit.ts の isEditablePath（削除と同じ） */
export const isMovablePath = isEditablePath;

export function parseMoveRequest(body: unknown): MoveRequest | null {
  if (!body || typeof body !== "object") return null;
  const { source, destination, baseSha } = body as Record<string, unknown>;
  if (typeof source !== "string" || typeof destination !== "string" ||
    !isEditablePath(source) || !isEditablePath(destination) || source === destination ||
    destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`) ||
    typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) return null;
  return { source, destination, baseSha };
}

export function moveFile(token: string, repo: Repo, branch: string, move: MoveRequest): Promise<boolean> {
  return editTree(token, repo, branch, [move.source, move.destination], ([source, destination]) => {
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
