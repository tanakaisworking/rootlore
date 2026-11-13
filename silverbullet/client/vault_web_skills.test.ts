import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { githubApiFetch } from "./vault_web_fetch.ts";
import {
  SKILLS,
  SkillInstallError,
  installSkill,
  isSkillInstalled,
  skillDir,
  skillLink,
  skillPaths,
} from "./vault_web_skills.ts";

vi.mock("./vault_web_fetch.ts", () => ({ githubApiFetch: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

const okf = SKILLS.find((skill) => skill.id === "okf")!;
const repo = { owner: "me", repo: "notes" };
const apiBase = "https://app.example/api/gh";

test("スキルは .claude/skills/<id>/ の下に置く", () => {
  expect(skillDir("okf")).toBe(".claude/skills/okf");
  expect(skillPaths(okf)).toEqual([".claude/skills/okf/SKILL.md"]);
});

test("Codex 用の symlink は .agents/skills/<id> から .claude/skills/<id> を指す", () => {
  expect(skillLink(okf)).toEqual({
    path: ".agents/skills/okf",
    target: "../../.claude/skills/okf",
  });
});

test("カタログの id は重複せず、どのスキルにも SKILL.md がある", () => {
  expect(new Set(SKILLS.map((skill) => skill.id)).size).toBe(SKILLS.length);
  for (const skill of SKILLS) {
    expect(skill.files.some((file) => file.path === "SKILL.md")).toBe(true);
  }
});

test("置き場所を決めるスキルは1本だけにし、土台の OKF はそれと分ける", () => {
  // OKF はノートの形をそろえるだけで、フォルダの分け方には口を出さない
  const base = SKILLS.filter((skill) => skill.group === "base");
  expect(base.map((skill) => skill.id)).toEqual(["okf"]);
  // ここが2本以上になると「このノートはどこか」の答えが食い違う
  const layout = SKILLS.filter((skill) => skill.group === "layout");
  expect(layout.map((skill) => skill.id)).toEqual([
    "para",
    "johnny-decimal",
    "llm-wiki",
  ]);
  expect(base.length + layout.length).toBe(SKILLS.length);
});

test("どのスキルも、Agent Skills の frontmatter と名前の形になっている", () => {
  // 仕様で決まっている項目だけを、トップレベルに置いてよい
  const topLevel = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
  for (const skill of SKILLS) {
    // id は name と同じ形（小文字・数字・ハイフン）で、フォルダ名にもなる
    expect(skill.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(skill.id.length).toBeLessThanOrEqual(64);
    const body = skill.files.find((file) => file.path === "SKILL.md")!.content;
    expect(body.startsWith("---\n")).toBe(true);
    const end = body.indexOf("\n---", 4);
    expect(end).toBeGreaterThan(0);
    const lines = body.slice(4, end).split("\n");
    // name は親フォルダの名前と一致する
    expect(lines[0]).toBe(`name: ${skill.id}`);
    const description = lines.find((line) => line.startsWith("description: "));
    expect(description).toBeDefined();
    expect(description!.length).toBeGreaterThan("description: ".length);
    expect(description!.length).toBeLessThanOrEqual(1024);
    for (const line of lines) {
      const key = /^([a-z-]+):/.exec(line)?.[1];
      if (key) expect(topLevel).toContain(key);
    }
    // 本文は 500 行まで（仕様の目安）
    expect(body.split("\n").length).toBeLessThan(500);
  }
});

test("追加済みかは、SKILL.md の有無を GitHub に聞く", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ name: "SKILL.md" }));
  expect(await isSkillInstalled(apiBase, repo, okf)).toBe(true);
  const [, path, , options] = vi.mocked(githubApiFetch).mock.calls[0]!;
  expect(path).toBe("/repos/me/notes/contents/.claude/skills/okf/SKILL.md");
  // 401 のときにログイン画面へ移らない（押したときに知らせる）
  expect(options).toEqual({ redirectToLogin: false });

  vi.mocked(githubApiFetch).mockResolvedValue(new Response("", { status: 404 }));
  expect(await isSkillInstalled(apiBase, repo, okf)).toBe(false);
});

test("追加は1コミットで、本文を base64 にして symlink も一緒に送る", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(Response.json({ files: [] }));
  await installSkill(apiBase, okf);
  const [, path, init] = vi.mocked(githubApiFetch).mock.calls[0]!;
  expect(path).toBe("/commit");
  expect(init?.method).toBe("POST");
  const body = JSON.parse(String(init?.body)) as {
    files: { path: string; content: string; baseSha: string | null }[];
    symlinks: { path: string; target: string; baseSha: string | null }[];
    message: string;
  };
  expect(body.files).toHaveLength(1);
  expect(body.files[0]!.path).toBe(".claude/skills/okf/SKILL.md");
  expect(body.files[0]!.baseSha).toBeNull();
  // atob は1文字1バイトの文字列を返すので、UTF-8 に戻してから比べる
  const bytes = Uint8Array.from(atob(body.files[0]!.content), (c) => c.charCodeAt(0));
  expect(new TextDecoder().decode(bytes)).toBe(okf.files[0]!.content);
  expect(body.symlinks).toEqual([
    { path: ".agents/skills/okf", target: "../../.claude/skills/okf", baseSha: null },
  ]);
  expect(body.message).toContain("OKF");
});

test("既にあるときとログイン切れは、わけのわかる印にする", async () => {
  vi.mocked(githubApiFetch).mockResolvedValue(new Response("", { status: 409 }));
  await expect(installSkill(apiBase, okf)).rejects.toThrow(new SkillInstallError("exists"));
  vi.mocked(githubApiFetch).mockResolvedValue(new Response("", { status: 401 }));
  await expect(installSkill(apiBase, okf)).rejects.toThrow(new SkillInstallError("login"));
});

test("OKF のスキルは、本家の仕様を出典として持ち、frontmatter が仕様の形になっている", () => {
  expect(okf.source.url).toContain("open-knowledge-format");
  const body = okf.files[0]!.content;
  expect(body).toContain("type:");
  expect(body).toContain("index.md");
  // 仕様では任意の項目は metadata の下に置く（トップレベルは name と description だけ）
  const frontmatter = body.slice(4, body.indexOf("\n---", 4));
  expect(frontmatter.split("\n").map((line) => line.split(":")[0])).toEqual([
    "name",
    "description",
    "metadata",
    "  source",
    "  spec",
    "  version",
  ]);
});
