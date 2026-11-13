import { expect, test } from "vitest";
import {
  clearDraft, decodeNote, gitBlobSha, listDrafts, saveNote, SaveError, writeDraft,
  clearAllDrafts,
} from "./vault_web_save.ts";

const repo = { owner: "me", repo: "notes", branch: "main" };
const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const utf8 = (text: string) => new TextEncoder().encode(text);
const fromBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

/** Worker の返事を順に返す。送った中身を残す */
function worker(replies: ((path: string, init: RequestInit) => Response)[]) {
  const calls: { path: string; body?: any; options?: any }[] = [];
  const fetchApi = async (_base: string, path: string, init: RequestInit = {}, options?: any) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body as string) : undefined, options });
    return replies.shift()!(path, init);
  };
  return { calls, fetchApi: fetchApi as any };
}
const saved = (sha: string) => () => Response.json({ commit: "c", files: [{ path: "a.md", sha }] });
const moved = (sha: string | null) => () => Response.json({ conflicts: [{ path: "a.md", sha }] }, { status: 409 });
const blob = (text: string) => () => new Response(utf8(text));

test("gitBlobSha matches git hash-object", async () => {
  // printf 'hello\n' | git hash-object --stdin
  expect(await gitBlobSha(utf8("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  expect(await gitBlobSha(utf8(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("decodeNote refuses bytes that are not UTF-8", () => {
  expect(decodeNote(utf8("日本語"))).toBe("日本語");
  expect(decodeNote(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
});

test("saves with the version it was read at", async () => {
  const { calls, fetchApi } = worker([saved(shaB)]);
  const outcome = await saveNote("/api/gh", repo, "a.md", { text: "a\n", sha: shaA }, "日本語\n", fetchApi);
  expect(outcome).toEqual({ status: "saved", sha: shaB, merged: false });
  expect(calls[0]!.path).toBe("/commit");
  const file = calls[0]!.body.files[0];
  expect(file).toMatchObject({ path: "a.md", baseSha: shaA });
  expect(fromBase64(file.content)).toBe("日本語\n");
});

test("merges with GitHub's newer version when different lines changed", async () => {
  const { calls, fetchApi } = worker([moved(shaB), blob("1\n2\n3（GitHub）\n"), saved("c".repeat(40))]);
  const outcome = await saveNote("/api/gh", repo, "a.md", { text: "1\n2\n3\n", sha: shaA }, "1（画面）\n2\n3\n", fetchApi);
  expect(outcome).toMatchObject({ status: "saved", merged: true });
  expect(calls[1]!.path).toBe(`/repos/me/notes/git/blobs/${shaB}`);
  expect(calls[2]!.body.files[0].baseSha).toBe(shaB);
  expect(fromBase64(calls[2]!.body.files[0].content)).toBe("1（画面）\n2\n3（GitHub）\n");
});

test("returns marked text and GitHub's version when the same line changed", async () => {
  const { calls, fetchApi } = worker([moved(shaB), blob("1\nGitHub\n")]);
  const outcome = await saveNote("/api/gh", repo, "a.md", { text: "1\n2\n", sha: shaA }, "1\n画面\n", fetchApi);
  expect(outcome.status).toBe("conflict");
  if (outcome.status !== "conflict") return;
  expect(outcome.text).toContain("<<<<<<< この端末の変更\n画面\n=======\nGitHub\n>>>>>>> GitHub の変更");
  expect(outcome.base).toEqual({ text: "1\nGitHub\n", sha: shaB });
  expect(calls).toHaveLength(2);
  // 印が残ったままでは送らない
  await expect(saveNote("/api/gh", repo, "a.md", outcome.base, outcome.text, fetchApi)).rejects.toThrow(SaveError);
  expect(calls).toHaveLength(2);
});

test("a note deleted on GitHub is saved again as a new note", async () => {
  const { calls, fetchApi } = worker([moved(null), saved(shaB)]);
  const outcome = await saveNote("/api/gh", repo, "a.md", { text: "a\n", sha: shaA }, "a\nb\n", fetchApi);
  expect(outcome.status).toBe("conflict");
  if (outcome.status !== "conflict") return;
  expect(outcome.base).toEqual({ text: "", sha: null });
  expect(calls).toHaveLength(1);
});

test("an expired sign-in is reported without leaving the page", async () => {
  const { calls, fetchApi } = worker([() => Response.json({ error: "login" }, { status: 401 })]);
  await expect(saveNote("/api/gh", repo, "a.md", { text: "", sha: shaA }, "x", fetchApi)).rejects.toThrow("login");
  // ログイン画面へ移ると、直した本文がなくなる
  expect(calls[0]!.options).toEqual({ redirectToLogin: false });
});

test("other failures are errors", async () => {
  const { fetchApi } = worker([() => new Response("", { status: 500 })]);
  await expect(saveNote("/api/gh", repo, "a.md", { text: "", sha: shaA }, "x", fetchApi)).rejects.toThrow("HTTP 500");
});

test("drafts are kept per editing session, so one tab never removes another tab's draft", () => {
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  const scope = { repo, path: "日記/a.md" };
  const older = { text: "タブA", base: { text: "元", sha: shaA }, savedAt: 1 };
  const newer = { text: "タブB", base: { text: "元", sha: shaA }, savedAt: 2 };
  expect(writeDraft(scope, "A", older, store)).toBe(true);
  expect(writeDraft(scope, "B", newer, store)).toBe(true);
  expect(listDrafts(scope, store)).toEqual([
    { id: "B", draft: newer },
    { id: "A", draft: older },
  ]);
  // 別のノート・別のリポジトリの下書きは混ざらない
  expect(listDrafts({ repo, path: "日記/b.md" }, store)).toEqual([]);
  expect(listDrafts({ repo: { ...repo, repo: "other" }, path: "日記/a.md" }, store)).toEqual([]);
  // タブA が保存して自分の下書きを消しても、タブB の下書きは残る
  clearDraft(scope, "A", store);
  expect(listDrafts(scope, store)).toEqual([{ id: "B", draft: newer }]);
  data.set([...data.keys()][0]!, "{broken");
  expect(listDrafts(scope, store)).toEqual([]);
});

test("a full browser storage reports that the draft wasn't kept", () => {
  const store = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => undefined,
    key: () => null,
    length: 0,
  };
  expect(writeDraft({ repo, path: "a.md" }, "A", { text: "x", base: { text: "", sha: null }, savedAt: 1 }, store)).toBe(false);
});

test("ログアウトのときは、この端末の下書きをすべて消す（編集前の本文も残さない）", () => {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  const scope = { repo: { owner: "me", repo: "notes", branch: "main" }, path: "a.md" };
  const draft = { text: "直した", base: { text: "元の本文", sha: null }, savedAt: 1 };
  writeDraft(scope, "one", draft, fake);
  writeDraft(scope, "two", draft, fake);
  // 下書きでないものは残す
  fake.setItem("vw-language", "ja");

  expect(clearAllDrafts(fake)).toBe(2);
  expect(listDrafts(scope, fake)).toEqual([]);
  expect(fake.getItem("vw-language")).toBe("ja");
  // 元の本文も残っていない
  expect(JSON.stringify([...store.values()])).not.toContain("元の本文");
});
