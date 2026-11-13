import {
  clientStore,
  editor,
  index,
  space,
  sync,
} from "@silverbulletmd/silverbullet/syscalls";

let lastProgress = -1;
let lastProgressAt = 0;

/**
 * vault-web: 画面の言語（client/vault_web_i18n.ts）。プラグは別の Worker で動き、localStorage を読めないので、
 * 画面が clientStore に残した vwLanguage を読む
 */
async function t(ja: string, en: string): Promise<string> {
  return (await clientStore.get("vwLanguage").catch(() => undefined)) === "en"
    ? en
    : ja;
}

async function requireSyncEnabled(): Promise<boolean> {
  if (await sync.isEnabled()) {
    return true;
  }
  await editor.flashNotification(
    await t(
      "このブラウザでは最新の状態に更新できません",
      "Sync is disabled because the service worker is off",
    ),
    "error",
  );
  return false;
}

export async function syncSpaceCommand() {
  if (!(await requireSyncEnabled())) {
    return;
  }
  // vault-web: 日本語にし、終わったら開いているページを読み直す（ホームの「最近の更新」も新しくなる）
  await editor.flashNotification(
    await t("最新の状態に更新しています…", "Refreshing from GitHub…"),
  );
  await sync.performSpaceSync();
  await editor.reloadPage();
  await editor.flashNotification(
    await t("最新の状態に更新しました", "Up to date"),
  );
}

export async function syncFileCommand() {
  if (!(await requireSyncEnabled())) {
    return;
  }
  await editor.flashNotification("Syncing file...");
  await sync.performFileSync(await editor.getCurrentPath());
  await editor.flashNotification("Done.");
}

export async function spaceSyncComplete(message: { operations: number }) {
  if (message.operations > 0) {
    await space.listFiles();
  }

  void index.ensureFullIndex();
}

export async function fileSyncComplete(message: {
  path: string;
  operations: number;
}) {
  if (message.operations > 0) {
    // Re-read the specific file's metadata to trigger file:changed event
    await space.getFileMeta(message.path);
  }
}

export async function updateSyncStatus(event: {
  status: {
    filesProcessed: number;
    totalFiles: number;
  };
}) {
  const percentage = Math.round(
    (event.status.filesProcessed / event.status.totalFiles) * 100,
  );
  if (percentage >= 99) {
    await editor.hideProgress("sync");
    lastProgressAt = 0;
  } else {
    const now = Date.now();
    if (lastProgress !== percentage || now - lastProgressAt >= 1000) {
      lastProgress = percentage;
      lastProgressAt = now;
      await editor.showProgress("sync", percentage);
    }
  }
}
