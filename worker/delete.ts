// ファイルの削除。読んだときの版（baseSha）と GitHub の今の版が同じときだけ消す（tree_edit.ts）。
// 間に誰か（AI など）が書き換えていたら、消さずに 409 を返す。消したファイルも GitHub の履歴には残る。
import { ApiError, editTree, isEditablePath, readJsonRequest } from "./tree_edit";
import type { Repo } from "./proxy";

export type DeleteRequest = { path: string; baseSha: string };

export function parseDeleteRequest(body: unknown): DeleteRequest | null {
  if (!body || typeof body !== "object") return null;
  const { path, baseSha } = body as Record<string, unknown>;
  if (typeof path !== "string" || !isEditablePath(path) ||
    typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) return null;
  return { path, baseSha };
}

export function deleteFile(token: string, repo: Repo, branch: string, request: DeleteRequest): Promise<boolean> {
  return editTree(token, repo, branch, [request.path], ([found]) => {
    if (!found || found === "blocked" || found.type !== "blob" || found.sha !== request.baseSha) return null;
    return {
      message: `Rootlore: Delete ${request.path}`,
      changes: [{ path: request.path, mode: found.mode, type: "blob", sha: null }],
    };
  });
}

export async function handleDelete(request: Request, token: string, repo: Repo, branch: string): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const read = await readJsonRequest(request);
  if (read instanceof Response) return read;
  const target = parseDeleteRequest(read.body);
  if (!target) return new Response("Bad Request", { status: 400, headers });
  try {
    return await deleteFile(token, repo, branch, target)
      ? Response.json({ deleted: true }, { headers })
      : Response.json({ error: "conflict" }, { status: 409, headers });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return Response.json({ error: "refresh" }, { status: 401, headers });
    throw e;
  }
}
