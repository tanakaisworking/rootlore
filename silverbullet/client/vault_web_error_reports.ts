// vault-web: エラーの報告（Sentry）。画面で起きた例外を、Worker の api/errors を通して送る。
// - 送り先（DSN）は Worker が持つ。ここの DSN は形だけのもので、Worker が本物に差し替える（worker/errors.ts）
// - ノートの中身を送らないための削りも Worker がかける。ここでは、操作の記録（breadcrumbs）と
//   セッションの記録を最初から取らない
// - 設定の「エラーの報告」で止められる（localStorage の rootlore-error-reports = off。この端末だけ）
// boot.ts の最初に読み込む（起動中に止まったときも拾うため）。

import {
  type BrowserClient,
  type BrowserOptions,
  captureException,
  getClient,
  init,
} from "@sentry/browser";
import { version as publicVersion } from "../version.json";

const settingKey = "rootlore-error-reports";
/** 1回の読み込みで送る数の上限。同じ例外が続いても、無料枠を使い切らない */
const MAX_EVENTS_PER_PAGE = 10;
/** デスクトップ版の同梱の画面（desktop/src-tauri/src/local.rs の PORT） */
const DESKTOP_PORT = "37420";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readErrorReportsSetting(
  store: Pick<Storage, "getItem"> | undefined,
): boolean {
  return store?.getItem(settingKey) !== "off";
}

export function surfaceOf(location: Pick<Location, "hostname" | "port">): "desktop" | "web" {
  return (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
      location.port === DESKTOP_PORT
    ? "desktop"
    : "web";
}

function environmentOf(location: Pick<Location, "hostname" | "port">): string {
  if (surfaceOf(location) === "desktop") return "production";
  return location.hostname === "rootlore.app" ? "production" : "development";
}

/** init に渡す設定。送り先は baseURI からの相対（Web は /v/api/errors、デスクトップも同じ） */
export function errorReportOptions(
  location: Pick<Location, "hostname" | "port">,
  baseURI: string,
): BrowserOptions {
  let sent = 0;
  return {
    dsn: "https://rootlore@errors.rootlore.invalid/0",
    tunnel: new URL("api/errors", baseURI).href,
    release: `rootlore@${publicVersion}`,
    environment: environmentOf(location),
    initialScope: { tags: { surface: surfaceOf(location) } },
    // 利用者・Cookie・ヘッダー・通信の中身・URL の query を集めない（Worker でも削る）
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      // 関数の中の変数（ノートの本文が入りうる）と、ソースの前後の行を取らない
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    maxBreadcrumbs: 0,
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== "Breadcrumbs" && i.name !== "BrowserSession"),
    beforeSend: (event) => (++sent > MAX_EVENTS_PER_PAGE ? null : event),
  };
}

let active = false;

export function startErrorReports(): void {
  if (!globalThis.document || active) return;
  active = true;
  // 報告の仕組みが動かなくても、アプリは止めない
  try {
    init(errorReportOptions(location, document.baseURI));
  } catch (e) {
    active = false;
    console.warn("Could not start error reports", e);
  }
}

/** アプリが自分で受け止めた例外を送る（未捕捉の例外は SDK が拾う）。止めているときは何もしない */
export function reportException(e: unknown): void {
  if (!active) return;
  try {
    captureException(e);
  } catch {
    // 報告の失敗でアプリを止めない
  }
}

export function errorReportsEnabled(): boolean {
  return readErrorReportsSetting(storage());
}

export function saveErrorReportsSetting(on: boolean): void {
  try {
    if (on) storage()?.removeItem(settingKey);
    else storage()?.setItem(settingKey, "off");
  } catch {
    // 保存できないブラウザでは、この読み込みの間だけ切り替える
  }
  if (on) {
    startErrorReports();
  } else if (active) {
    active = false;
    void (getClient() as BrowserClient | undefined)?.close();
  }
}

if (errorReportsEnabled()) startErrorReports();
