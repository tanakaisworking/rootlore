import { expect, test } from "vitest";
import { compareVersions, releaseToAnnounce, releases } from "./vault_web_releases.ts";

function memory(initial?: string) {
  const data = new Map<string, string>(initial ? [["rootlore-seen-release", initial]] : []);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

test("versions compare as numbers", () => {
  expect(compareVersions("0.0.10", "0.0.9")).toBe(1);
  expect(compareVersions("0.0.9", "0.0.10")).toBe(-1);
  expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
});

test("a new version is announced once; a first launch only remembers the version", () => {
  const fresh = memory();
  expect(releaseToAnnounce(fresh, "0.0.10")).toBeUndefined();
  expect(fresh.data.get("rootlore-seen-release")).toBe("0.0.10");

  const updated = memory("0.0.9");
  expect(releaseToAnnounce(updated, "0.0.10")).toBe("0.0.10");
  expect(releaseToAnnounce(updated, "0.0.10")).toBeUndefined();

  // 古い版に戻したときは知らせない（覚えている版も戻さない）
  const downgraded = memory("0.0.10");
  expect(releaseToAnnounce(downgraded, "0.0.9")).toBeUndefined();
  expect(downgraded.data.get("rootlore-seen-release")).toBe("0.0.10");
});

test("every release has notes in both languages, newest first", () => {
  for (const r of releases) {
    expect(r.ja.length).toBeGreaterThan(0);
    expect(r.ja.length).toBe(r.en.length);
  }
  for (let i = 1; i < releases.length; i++) {
    expect(compareVersions(releases[i - 1].version, releases[i].version)).toBe(1);
  }
});
