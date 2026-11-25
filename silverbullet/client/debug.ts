// vault-web: client と画面（ui）は起動の後半で作られる。それより前の未処理の例外は
// エラーの報告（vault_web_error_reports.ts の Sentry SDK）が拾うので、ここでは渡さない。
// 渡すと、まだ無い client や ui を参照して、この処理自体が落ちる
globalThis.addEventListener("unhandledrejection", (event) => {
  const client = (globalThis as any).client;
  if (!client?.ui || event.reason == null) return;
  client.reportError(event.reason);
});

export {};
