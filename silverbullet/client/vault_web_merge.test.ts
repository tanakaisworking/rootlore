import { expect, test } from "vitest";
import { diff3Merge } from "node-diff3";
import { Text } from "@codemirror/state";
import { findConflictHunks } from "./codemirror/conflict_markers.ts";
import { hasMergeConflict, mergeText } from "./vault_web_merge.ts";

const base = "# 買い物\n\n- 牛乳\n- 卵\n- パン\n";

test("takes one side when only the other side is unchanged", () => {
  expect(mergeText(base, base + "- 米\n", base)).toEqual({ text: base + "- 米\n", conflicts: 0 });
  expect(mergeText(base, base, "x")).toEqual({ text: "x", conflicts: 0 });
  expect(mergeText(base, "same", "same")).toEqual({ text: "same", conflicts: 0 });
});

test("combines edits to different lines", () => {
  const mine = base.replace("- 牛乳", "- 豆乳");
  const theirs = base.replace("- パン", "- パン（全粒粉）");
  expect(mergeText(base, mine, theirs)).toEqual({
    text: "# 買い物\n\n- 豆乳\n- 卵\n- パン（全粒粉）\n",
    conflicts: 0,
  });
});

test("keeps both versions of the same line between markers the editor understands", () => {
  const mine = base.replace("- 卵", "- 卵 10個");
  const theirs = base.replace("- 卵", "- 卵 6個");
  const merged = mergeText(base, mine, theirs);
  expect(merged.conflicts).toBe(1);
  expect(hasMergeConflict(merged.text)).toBe(true);
  const [hunk] = findConflictHunks(Text.of(merged.text.split("\n")));
  expect(hunk.kind).toBe("git");
  expect(hunk.first.text).toBe("- 卵 10個\n");
  expect(hunk.second.text).toBe("- 卵 6個\n");
  expect(hunk.first.label).toBe("この端末の変更");
  expect(hunk.second.label).toBe("GitHub の変更");
});

test("a note created on both sides conflicts as a whole", () => {
  const merged = mergeText("", "mine\n", "theirs\n");
  expect(merged.conflicts).toBe(1);
});

test("hasMergeConflict ignores ordinary git markers but not partial leftovers", () => {
  expect(hasMergeConflict("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n")).toBe(false);
  expect(hasMergeConflict("<<<<<<< この端末の変更\na\n=======\nb\n")).toBe(true);
  expect(hasMergeConflict("a\n=======\nb\n>>>>>>> GitHub の変更\n")).toBe(true);
  expect(hasMergeConflict("見出し\n=======\n")).toBe(false);
  expect(hasMergeConflict("plain")).toBe(false);
});

test("a note with very many lines merges without running out of stack", () => {
  const body = Array.from({ length: 140_000 }, (_, i) => `line ${i}`).join("\n");
  const merged = mergeText(body, `mine\n${body}`, `${body}\ntheirs`);
  expect(merged.conflicts).toBe(0);
  expect(merged.text).toBe(`mine\n${body}\ntheirs`);
});

test("a long note with many repeated lines merges quickly", () => {
  // 空行のように同じ行が多いと、node-diff3 の比べ方はとても遅くなる（1万行で約90秒）
  const body = Array.from({ length: 10_000 }, (_, i) => (i % 3 === 2 ? "" : `line ${i}`)).join("\n");
  const merged = mergeText(body, `mine\n${body}`, `${body}\ntheirs`);
  expect(merged.text).toBe(`mine\n${body}\ntheirs`);
});

/** 前の書き方（node-diff3 の diff3Merge をそのまま使う）。小さい本文で結果を比べる */
function mergeWithDiff3Merge(base: string, mine: string, theirs: string) {
  const lines: string[] = [];
  let conflicts = 0;
  for (const region of diff3Merge(mine.split("\n"), base.split("\n"), theirs.split("\n"), {
    excludeFalseConflicts: true,
  })) {
    if (region.ok) lines.push(...region.ok);
    else if (region.conflict) {
      conflicts++;
      lines.push(
        "<<<<<<< この端末の変更",
        ...region.conflict.a,
        "=======",
        ...region.conflict.b,
        ">>>>>>> GitHub の変更",
      );
    }
  }
  return { text: lines.join("\n"), conflicts };
}

// 元の行がすべて違えば、行の対応は1通りに決まる。そのときは diff3Merge と同じ結果になる
// （同じ行がくり返す本文では、正しい対応が複数あり、選び方が違うことがある）
test("merges the same way as diff3Merge", () => {
  let seed = 1;
  const random = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  const edit = (lines: string[]) => {
    const out = [...lines];
    for (let k = random(4); k >= 0; k--) {
      const at = random(out.length + 1);
      const op = random(3);
      // 書き足す行は少ない種類から選び、両方で同じ変更をした場合も試す
      if (op === 0) out.splice(at, 0, `x${random(3)}`);
      else if (op === 1) out.splice(at, 1);
      else out.splice(at, 1, `y${random(3)}`);
    }
    return out.join("\n");
  };
  for (let i = 0; i < 3000; i++) {
    const lines = Array.from({ length: random(12) }, (_, n) => `l${n}`);
    const base = lines.join("\n");
    const mine = edit(lines);
    const theirs = edit(lines);
    if (mine === theirs || mine === base || theirs === base) continue;
    expect(mergeText(base, mine, theirs), JSON.stringify({ base, mine, theirs })).toEqual(
      mergeWithDiff3Merge(base, mine, theirs),
    );
  }
});

test("too many differences to compare keep both versions whole", () => {
  const base = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const mine = ["mine", ...base.map((line) => `${line} (me)`)].join("\n");
  const theirs = [...base, "theirs"].join("\n");
  const merged = mergeText(base.join("\n"), mine, theirs);
  expect(merged.conflicts).toBe(1);
  expect(merged.text).toBe(`<<<<<<< この端末の変更\n${mine}\n=======\n${theirs}\n>>>>>>> GitHub の変更`);
});
