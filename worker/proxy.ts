// ブラウザ（Service Worker）からの GitHub API の呼び出しを中継する。
// 接続したリポジトリの、決まった操作だけを通す。

import { githubHeaders } from "./github";

const API = "https://api.github.com";

export type Repo = { owner: string; repo: string };

type Rule = { method: string; pattern: RegExp };

function rules({ owner, repo }: Repo): Rule[] {
  const base = `/repos/${escape(owner)}/${escape(repo)}`;
  return [
    // アカウントのページの「接続中のリポジトリ」（名前、公開・非公開、説明、最終更新）
    { method: "GET", pattern: new RegExp(`^${base}$`) },
    { method: "GET", pattern: new RegExp(`^${base}/git/trees/[^/]+$`) },
    { method: "GET", pattern: new RegExp(`^${base}/git/blobs/[0-9a-f]{40}$`) },
    // 最初の画面の「最近の更新」
    { method: "GET", pattern: new RegExp(`^${base}/commits$`) },
    { method: "GET", pattern: new RegExp(`^${base}/commits/[0-9a-f]{40}$`) },
    // 最初の画面の草のグラフとグロースグラフ（過去1年の、日ごとのコミット数）
    { method: "GET", pattern: new RegExp(`^${base}/stats/commit_activity$`) },
    // スキルのページの「追加済み」。ノートの一覧には隠しフォルダが出ないので、ファイルの有無を直接見る
    { method: "GET", pattern: new RegExp(`^${base}/contents/\\.claude/skills/[a-z0-9-]+/SKILL\\.md$`) },
    { method: "POST", pattern: /^\/graphql$/ },
  ];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type GraphQLBody = { query: string; variables: Record<string, unknown> };

/** 1回の GraphQL で取る blob の上限（client の batchSize と同じ） */
export const MAX_BLOBS = 250;

/**
 * GraphQL はブラウザから query を受け取らない。blob の SHA の一覧だけを受け取り、
 * 接続したリポジトリの blob を読む query をここで組み立てる。
 */
export function blobsGraphQL(body: unknown, { owner, repo }: Repo): GraphQLBody | null {
  if (!body || typeof body !== "object") return null;
  const { shas } = body as { shas?: unknown };
  if (!Array.isArray(shas) || shas.length === 0 || shas.length > MAX_BLOBS) return null;
  if (!shas.every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha))) return null;
  const fields = shas
    .map((sha, i) => `b${i}: object(oid: "${sha}") { ... on Blob { text isBinary isTruncated byteSize } }`)
    .join("\n");
  return {
    query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${fields}\n} }`,
    variables: { owner, name: repo },
  };
}

const passRequestHeaders = ["If-None-Match", "Content-Type"];
const allowedAccept = new Set(["application/vnd.github.raw+json"]);
const passResponseHeaders = [
  "Content-Type",
  "ETag",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  "X-RateLimit-Resource",
];

export async function proxyGitHub(
  request: Request,
  apiPath: string,
  token: string,
  repo: Repo,
): Promise<Response> {
  if (apiPath.includes("..")) return new Response("Forbidden", { status: 403 });
  const pathOnly = apiPath.split("?")[0]!;
  const allowed = rules(repo).some(
    (rule) => rule.method === request.method && rule.pattern.test(pathOnly),
  );
  if (!allowed) return new Response("Forbidden", { status: 403 });

  const headers: Record<string, string> = githubHeaders(token);
  for (const name of passRequestHeaders) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const accept = request.headers.get("Accept");
  if (accept && allowedAccept.has(accept)) headers.Accept = accept;

  let body: string | undefined;
  if (request.method === "POST") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const graphql = blobsGraphQL(parsed, repo);
    if (!graphql) return new Response("Forbidden", { status: 403 });
    body = JSON.stringify(graphql);
  }

  const upstream = await fetch(`${API}${apiPath}`, { method: request.method, headers, body });
  if (upstream.status === 401) {
    // 期限前にトークンが使えなくなった（取り消し、など）。ブラウザに更新してもらい、
    // 更新もできなければ /.auth/refresh がログインし直しを求める
    return Response.json({ error: "refresh" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  // 中身が SHA で決まるもの（blob、commit、SHA で指したファイルの一覧）は変わらないので、ブラウザにだけ置いてよい
  const immutable = upstream.ok && /\/(git\/blobs|git\/trees|commits)\/[0-9a-f]{40}$/.test(pathOnly);
  const responseHeaders = new Headers({
    "Cache-Control": immutable ? "private, max-age=31536000, immutable" : "no-store",
  });
  for (const name of passResponseHeaders) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
