// vault-web: Service Worker の登録を待つ処理（boot.ts から使う）。
// Service Worker を使えない環境（Mac アプリの WebView の http://127.0.0.1、古い Android など）では
// register が失敗する。その失敗を未処理の例外にせず、起動を止めないための部品。

/**
 * Service Worker がこのページを受け持つのを待つ。受け持てば true。
 * 登録に失敗したら、待つ時間の終わりを待たずにすぐ false を返す
 */
export function waitForControl(
  controlled: Promise<boolean>,
  registered: Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    controlled,
    // 登録できたら、受け持つか時間切れかで決まる。ここでは決めない
    registered.then((ok) => (ok ? new Promise<boolean>(() => {}) : false)),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
