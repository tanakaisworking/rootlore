import { expect, test } from "vitest";
import { activityDays, niceMax } from "./vault_web_activity.ts";

// 2026-10-25（日）と 2026-11-01（日）からの2週
const SUN1 = Date.UTC(2026, 9, 25) / 1000;
const SUN2 = Date.UTC(2026, 10, 1) / 1000;
const weeks = [
  { week: SUN1, days: [0, 4, 0, 0, 1, 0, 0], total: 5 },
  { week: SUN2, days: [0, 2, 0, 0, 0, 0, 0], total: 2 },
];

test("places each day by week and weekday, and skips days after today", () => {
  const days = activityDays(weeks, Date.UTC(2026, 10, 3, 12));
  expect(days).toHaveLength(7 + 3);
  expect(days[1]).toMatchObject({ date: "2026-10-26", count: 4, column: 0, row: 1, level: 4 });
  expect(days[4]).toMatchObject({ date: "2026-10-29", count: 1, level: 1 });
  expect(days[8]).toMatchObject({ date: "2026-11-02", count: 2, column: 1, row: 1, level: 2 });
  expect(days.at(-1)!.date).toBe("2026-11-03");
  expect(days[0]!.level).toBe(0);
});

test("rounds the top of the scale to 1, 2, 5 steps", () => {
  expect([0, 1, 2, 3, 7, 10, 11, 42, 120].map(niceMax)).toEqual([1, 1, 2, 5, 10, 10, 20, 50, 200]);
});

test("no updates at all leaves every day empty", () => {
  const days = activityDays([{ week: SUN1, days: [0, 0, 0, 0, 0, 0, 0], total: 0 }], Date.UTC(2026, 10, 3));
  expect(days.every((d) => d.level === 0)).toBe(true);
});
