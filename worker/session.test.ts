import { expect, test } from "vitest";
import { seal, unseal } from "./session";

const secret = "x".repeat(32);

test("sealed data comes back only with the same secret", async () => {
  const sealed = await seal({ token: "ghu_visible" }, secret);
  expect(sealed).not.toContain("ghu_visible");
  expect(await unseal(sealed, secret)).toEqual({ token: "ghu_visible" });
  expect(await unseal(sealed, "y".repeat(32))).toBeNull();
});

test("tampered or malformed data is rejected", async () => {
  const sealed = await seal({ a: 1 }, secret);
  const [iv, body] = sealed.split(".");
  const flipped = body!.slice(0, -2) + (body!.endsWith("A") ? "BB" : "AA");
  expect(await unseal(`${iv}.${flipped}`, secret)).toBeNull();
  expect(await unseal("nonsense", secret)).toBeNull();
});
