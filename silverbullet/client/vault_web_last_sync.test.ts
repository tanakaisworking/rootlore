import { expect, test } from "vitest";
import { readLastSync } from "./vault_web_last_sync.ts";

test("残していなければ、または変な値なら、まだ同期していない（undefined）", () => {
  expect(readLastSync({ getItem: () => null })).toBeUndefined();
  expect(readLastSync({ getItem: () => "abc" })).toBeUndefined();
  expect(readLastSync({ getItem: () => "0" })).toBeUndefined();
  expect(readLastSync({ getItem: () => "1793721399720" })).toBe(1793721399720);
});
