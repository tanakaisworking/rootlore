import { afterEach, expect, test, vi } from "vitest";
import { githubApiFetch } from "./vault_web_fetch.ts";

const api = "https://app.example/api/gh";

function stubServer(refreshResult: "ok" | "login") {
  let fresh = false;
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.endsWith("/.auth/refresh")) {
      await new Promise((r) => setTimeout(r, 5));
      if (refreshResult === "login") {
        return Response.json({ error: "login" }, { status: 401 });
      }
      fresh = true;
      return new Response(null, { status: 204 });
    }
    return fresh
      ? Response.json({ ok: true })
      : Response.json({ error: "refresh" }, { status: 401 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

test("concurrent expired calls refresh once and both succeed", async () => {
  const calls = stubServer("ok");
  const [a, b] = await Promise.all([
    githubApiFetch(api, "/x"),
    githubApiFetch(api, "/y"),
  ]);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect(calls.filter((c) => c.endsWith("/.auth/refresh"))).toHaveLength(1);
});

test("a rejected refresh is returned as a login error", async () => {
  stubServer("login");
  const res = await githubApiFetch(api, "/x");
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "login" });
});

test("writes carry the repository this page has open, so another tab's switch can't redirect them", async () => {
  const seen: (string | null)[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers).get("X-Rootlore-Repo"));
    return Response.json({});
  });
  vi.stubGlobal("client", { bootConfig: { githubRepo: { owner: "me", repo: "notes", branch: "main" } } });
  await githubApiFetch(api, "/commit", { method: "POST", headers: { "Content-Type": "application/json" } });
  await githubApiFetch(api, "/move", { method: "POST" });
  await githubApiFetch(api, "/repos/me/notes/commits");
  expect(seen).toEqual(["me/notes", "me/notes", null]);
});
