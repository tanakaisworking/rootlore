import { expect, test } from "vitest";
import { buildGrowth, folderSizes, pickSnapshots, type Snapshot } from "./vault_web_growth.ts";

test("keeps the last commit of each day, oldest first", () => {
  const picked = pickSnapshots(
    [
      { date: "2026-05-29T15:00:00", tree: "c" },
      { date: "2026-05-29T09:00:00", tree: "b" },
      { date: "2026-05-05T09:00:00", tree: "a" },
    ],
    10,
  );
  expect(picked.map((c) => c.tree)).toEqual(["a", "c"]);
});

test("thins out evenly but keeps the first and last day", () => {
  const commits = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(2026, 0, i + 1, 12).toISOString(),
    tree: String(i),
  }));
  const picked = pickSnapshots(commits, 5);
  expect(picked.map((c) => c.tree)).toEqual(["0", "7", "15", "22", "29"]);
});

test("adds up notes by top folder, skipping other files and dot folders", () => {
  const folders = folderSizes([
    { path: "A/x.md", type: "blob", size: 100 },
    { path: "A/sub/y.md", type: "blob", size: 50 },
    { path: "A/img.png", type: "blob", size: 9999 },
    { path: "A", type: "tree" },
    { path: "top.md", type: "blob", size: 10 },
    { path: ".trash/old.md", type: "blob", size: 500 },
  ]);
  expect(Object.fromEntries(folders)).toEqual({
    A: { bytes: 150, notes: 2 },
    "": { bytes: 10, notes: 1 },
  });
});

const snap = (time: number, folders: Record<string, number>): Snapshot => ({
  time,
  folders: new Map(Object.entries(folders).map(([k, bytes]) => [k, { bytes, notes: 1 }])),
});

test("ranks folders by today's size, and puts the rest and removed folders in Other", () => {
  const growth = buildGrowth(
    [snap(1, { old: 40, A: 10 }), snap(2, { A: 30, B: 5, C: 1, D: 1 })],
    2,
  );
  expect(growth.series).toEqual([
    { folder: "A", values: [10, 30], notes: 1 },
    { folder: "B", values: [0, 5], notes: 1 },
    { folder: null, values: [40, 2], notes: 2 },
  ]);
  expect(growth.times).toEqual([1, 2]);
  expect(growth.totalBytes).toBe(37);
  expect(growth.totalNotes).toBe(4);
});

test("shows a single leftover folder by name instead of Other", () => {
  const growth = buildGrowth([snap(1, { A: 3, B: 2, C: 1 })], 2);
  expect(growth.series.map((s) => s.folder)).toEqual(["A", "B", "C"]);
});
