import { expect, test, vi } from "vitest";
import { requestDelete } from "./vault_web_delete.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("sends the path with the version that was read, and maps the Worker's answers", async () => {
  const fetchApi = vi.fn(async () => new Response(JSON.stringify({ deleted: true }), { status: 200 }));
  expect(await requestDelete("https://app/v/api/gh", "Notes/a.md", sha, fetchApi as any)).toBe("deleted");
  const [base, path, init] = fetchApi.mock.calls[0] as unknown as [string, string, RequestInit];
  expect([base, path, init.method]).toEqual(["https://app/v/api/gh", "/delete", "POST"]);
  expect(JSON.parse(init.body as string)).toEqual({ path: "Notes/a.md", baseSha: sha });

  for (const [status, result] of [[409, "conflict"], [412, "other-repo"], [401, "login"]] as const) {
    const answer = vi.fn(async () => new Response(null, { status }));
    expect(await requestDelete("https://app/v/api/gh", "Notes/a.md", sha, answer as any)).toBe(result);
  }
  await expect(requestDelete("https://app/v/api/gh", "Notes/a.md", sha, (async () => new Response(null, { status: 500 })) as any)).rejects.toThrow();
});
