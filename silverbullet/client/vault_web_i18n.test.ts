import { expect, test } from "vitest";
import { readLanguageSetting, resolveLanguage, t } from "./vault_web_i18n.ts";

test("only ja and en are kept as a setting; anything else is the system language", () => {
  const storage = (value: string | null) => ({ getItem: () => value });
  expect(readLanguageSetting(storage("en"))).toBe("en");
  expect(readLanguageSetting(storage("ja"))).toBe("ja");
  expect(readLanguageSetting(storage("fr"))).toBe("auto");
  expect(readLanguageSetting(storage(null))).toBe("auto");
  expect(readLanguageSetting(undefined)).toBe("auto");
});

test("system language is Japanese only for a Japanese browser", () => {
  expect(resolveLanguage("auto", "ja-JP")).toBe("ja");
  expect(resolveLanguage("auto", "ja")).toBe("ja");
  expect(resolveLanguage("auto", "en-US")).toBe("en");
  expect(resolveLanguage("auto", undefined)).toBe("en");
  expect(resolveLanguage("en", "ja-JP")).toBe("en");
  expect(resolveLanguage("ja", "en-US")).toBe("ja");
});

test("tests run in Japanese (vitest.setup.ts)", () => {
  expect(t("日本語", "English")).toBe("日本語");
});
