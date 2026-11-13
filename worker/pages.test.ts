import { expect, test } from "vitest";
import { loginPage, pageLang } from "./pages";

test("the language chosen in the app wins over the browser language", () => {
  expect(pageLang("a=1; vw-lang=en", "ja-JP,ja;q=0.9")).toBe("en");
  expect(pageLang("vw-lang=ja", "en-US,en;q=0.9")).toBe("ja");
});

test("without a choice, Japanese browsers get Japanese and others get English", () => {
  expect(pageLang(undefined, "ja-JP,ja;q=0.9,en;q=0.8")).toBe("ja");
  expect(pageLang(undefined, "en-US,ja;q=0.9")).toBe("en");
  expect(pageLang("vw-lang=fr", undefined)).toBe("en");
});

test("login page is written in the chosen language", () => {
  expect(loginPage("en")).toContain('<html lang="en">');
  expect(loginPage("en")).toContain("Sign in with GitHub");
  expect(loginPage("ja")).toContain("GitHubでログイン");
});
