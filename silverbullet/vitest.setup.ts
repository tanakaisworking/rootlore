// vault-web: テストは日本語の画面を前提にする（client/vault_web_i18n.ts は navigator.language で言語を決める）
Object.defineProperty(globalThis.navigator, "language", {
  value: "ja-JP",
  configurable: true,
});
