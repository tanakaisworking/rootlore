import { expect, test } from "vitest";
import { showConnectCard } from "./vault_web_connect_card.tsx";

test("まだ繋いでいないときだけ、サイドバーの下に連携の案内を出す", () => {
  expect(showConnectCard({ connected: false })).toBe(true);
});

test("繋いだあとは出さない", () => {
  expect(showConnectCard({ connected: true })).toBe(false);
});

test("判定が無いときは出さない（デスクトップ版など、口が connected を返さない場合）", () => {
  expect(showConnectCard({})).toBe(false);
});
