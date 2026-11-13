import { throttleImmediately } from "@silverbulletmd/silverbullet/lib/async";
import {
  deriveDbName,
  exportKey,
  importKey,
} from "@silverbulletmd/silverbullet/lib/crypto";
import { EncryptedKvPrimitives } from "./data/encrypted_kv_primitives.ts";
import { IndexedDBKvPrimitives } from "./data/indexeddb_kv_primitives.ts";
import type { KvPrimitives } from "./data/kv_primitives.ts";
import { initLogger } from "./lib/logger.ts";
import {
  handleShareTarget,
  isShareTarget,
  refreshShareEligibility,
} from "./capture/intake.ts";
import { openCaptureStore } from "./capture/store.ts";
import { WorkerLogout } from "./service_worker/logout.ts";
import { ProxyRouter } from "./service_worker/proxy_router.ts";
import { SyncEngine } from "./service_worker/sync_engine.ts";
import { DataStoreSpacePrimitives } from "./spaces/datastore_space_primitives.ts";
import { GitHubSpacePrimitives } from "./spaces/github_space_primitives.ts";
import { decodeSafetyText } from "./sync_recovery.ts";
import type {
  ServiceWorkerSourceMessage,
  ServiceWorkerTargetMessage,
} from "./types/ui.ts";

const logger = initLogger("[Service Worker]");

// Note: the only thing cached here is SilverBullet client assets, files are kept in IndexedDB
const CACHE_NAME = "{{CACHE_NAME}}";

//`location.href` minus this worker's filename will be our base URL, including any URL prefix
//(-1 is to remove the trailing '/')
const workerFilename = location.pathname.substring(
  location.pathname.lastIndexOf("/") + 1,
);
const baseURI = location.href.substring(
  0,
  location.href.length - workerFilename.length - 1,
);
const basePathName = location.pathname.substring(
  0,
  location.pathname.length - workerFilename.length - 1,
);

const precacheFiles = Object.fromEntries(
  // Dynamically replaced during build
  "{{PRECACHE_FILES}}"
    .split(",")
    .map((path) => [path, `${baseURI}${path}?v=${CACHE_NAME}`, path]),
); // Cache busting

const proxyRouter = new ProxyRouter(basePathName, baseURI, precacheFiles);
const captureStore = openCaptureStore(`${location.origin}${location.pathname}`);

let configuring = false;
/**
 * vault-web: 今の設定で開いているスペース（リポジトリ）。別のリポジトリを開いた、GitHub に繋いだ、
 * などで替わったら、前のリポジトリのまま動き続けないよう、同期を止めて作り直す
 */
let configuredSpace: string | undefined;
/** vault-web: 作っている途中のスペース。途中で別のスペースの設定が来たら、途中のものを捨てて作り直す */
let configuringSpace: string | undefined;

// vault-web: 作り直すたびに足さないよう、1つにしておく（proxyRouter.on は足していく）
const proxyRouterHandlers = {
  observedRequest: (path: string) => {
    // This is triggered for the currently open file, we want to proactively sync it to keep it up to date
    proxyRouter.syncEngine?.requestFileSync(path, { type: "probe" });
  },
  onlineStatusUpdated: (isOnline: boolean) => {
    broadcastMessage({
      type: "online-status",
      isOnline,
    });
  },
};

// @ts-expect-error: debugging
globalThis.proxyRouter = proxyRouter;

// This is the in-memory store of an encryption key that SB clients and the index engine can share without asking for it constantly
let encryptionKeyMemoryStore: CryptoKey | undefined;
let keyGeneration = 0;
let syncDatabaseName: string | undefined;
const workerLogout = new WorkerLogout(
  async () => {
    // @ts-expect-error: service worker API
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    return clients.filter(
      (client: { frameType: string }) => client.frameType !== "nested",
    );
  },
  async () => {
    keyGeneration++;
    encryptionKeyMemoryStore = undefined;
    proxyRouter.reset();
    await (await captureStore).destroy();
    // @ts-expect-error: service worker API
    await self.registration.unregister();
  },
  async () => {
    const engine = proxyRouter.syncEngine;
    if (engine) {
      while ((await engine.syncSpace()) !== 0) {
        if (!workerLogout.active) throw new Error("Logout was cancelled.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return syncDatabaseName ? [syncDatabaseName] : [];
    } else if (
      (await indexedDB.databases()).some((db) =>
        db.name?.startsWith("sb_files_"),
      )
    ) {
      throw new Error(
        "Open this space to synchronize its local data, or force logout to discard it.",
      );
    }
    return [];
  },
);

// Let's clean this encryptionKey if there's no more clients left for a little while, asking to re-enter
setInterval(() => {
  // @ts-expect-error: service worker API
  globalThis.clients.matchAll().then((clients) => {
    if (clients.length === 0 && encryptionKeyMemoryStore) {
      console.info("No more clients, flushing encryption key");
      encryptionKeyMemoryStore = undefined;
    }
  });
}, 5000); // little while is 5s

self.addEventListener("message", async (event: any) => {
  const message: ServiceWorkerTargetMessage = event.data;
  switch (message.type) {
    case "logout-sync":
    case "logout-cancel":
    case "logout-clear":
    case "logout-complete":
    case "logout-revoked":
    case "logout-preserve":
    case "logout-force": {
      event.waitUntil(workerLogout.handle(message, event.ports[0]));
      break;
    }
    case "skip-waiting": {
      // @ts-expect-error: Skip waiting to activate this service worker immediately
      self.skipWaiting();
      break;
    }
    case "claim": {
      // vault-web: boot.ts が、Service Worker がページを受け持っていないときに送る
      event.waitUntil((self as any).clients.claim());
      break;
    }
    case "shutdown": {
      proxyRouter.reset();
      break;
    }
    case "flush-cache": {
      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log("Removing cache", cacheName);
            return caches.delete(cacheName);
          }
        }),
      );
      broadcastMessage({
        type: "cacheFlushed",
      });
      break;
    }
    case "wipe-data": {
      await (await captureStore).clear();
      if (proxyRouter.syncEngine) {
        await proxyRouter.syncEngine.wipe();
        broadcastMessage({
          type: "dataWiped",
        });
      } else {
        console.warn("Not performing sync data wipe, sync engine not started");
      }
      break;
    }
    case "perform-file-sync": {
      if (proxyRouter.syncEngine) {
        proxyRouter.syncEngine.requestFileSync(
          message.path,
          message.remoteLastModified !== undefined
            ? {
                type: "remote",
                lastModified: message.remoteLastModified,
                hash: message.remoteRevisionHash,
              }
            : { type: "any" },
        );
      } else {
        console.warn(
          "perform-file-sync before configuration, asking the client for config",
        );
        // vault-web: しばらく何もしないと、ブラウザがこの Service Worker を止める。止まったあとは、
        // このメッセージで起こされても設定がなく、依頼を捨てていた（画面は30秒待ってエラーになる）。
        // 設定を送るように画面へ知らせる。設定が届くと、最初に全体の同期が走るので、依頼はそれで果たせる
        throttledServiceWorkerStarted();
      }

      break;
    }
    case "perform-space-sync": {
      if (proxyRouter.syncEngine) {
        proxyRouter.syncEngine.requestSpaceSync();
      } else {
        console.warn(
          "perform-space-sync before configuration, asking the client for config",
        );
        // vault-web: しばらく何もしないと、ブラウザがこの Service Worker を止める。止まったあとは、
        // このメッセージで起こされても設定がなく、依頼を捨てていた（画面は30秒待ってエラーになる）。
        // 設定を送るように画面へ知らせる。設定が届くと、最初に全体の同期が走るので、依頼はそれで果たせる
        throttledServiceWorkerStarted();
      }
      break;
    }
    case "declare-divergent-base": {
      await proxyRouter.syncEngine?.declareDivergentBase(
        message.path,
        message.baseText,
      );
      // The client waits for this before writing the divergent buffer.
      event.ports[0]?.postMessage({ type: "divergent-base-declared" });
      break;
    }
    case "realtime-status": {
      proxyRouter.syncEngine?.notifyRealtimeStatus(message.connected);
      break;
    }
    case "get-encryption-key": {
      if (workerLogout.active) break;
      event.source.postMessage({
        type: "encryption-key",
        key:
          encryptionKeyMemoryStore &&
          (await exportKey(encryptionKeyMemoryStore)),
      } as ServiceWorkerSourceMessage);
      break;
    }
    case "set-encryption-key": {
      if (workerLogout.active) break;
      const generation = keyGeneration;
      const key = await importKey(message.key);
      if (generation !== keyGeneration || workerLogout.active) break;
      encryptionKeyMemoryStore = key;
      console.info("Encryption phrase set");
      event.ports[0]?.postMessage({ type: "encryption-key-set" });
      break;
    }
    case "list-safety": {
      const raw = (await proxyRouter.syncEngine?.listSafety()) ?? [];
      const entries = await Promise.all(
        raw.map(async (entry) => {
          const data = await proxyRouter.syncEngine?.getSafety(entry.hash);
          return {
            ...entry,
            binary: data ? decodeSafetyText(data) === null : true,
          };
        }),
      );
      event.source.postMessage({
        type: "safety-list",
        entries,
      } as ServiceWorkerSourceMessage);
      break;
    }
    case "get-safety": {
      const data =
        (await proxyRouter.syncEngine?.getSafety(message.hash)) ?? null;
      event.source.postMessage({
        type: "safety-content",
        hash: message.hash,
        data,
      } as ServiceWorkerSourceMessage);
      break;
    }
    case "config": {
      if (workerLogout.active) break;
      let generation = keyGeneration;
      const encryptionKey = encryptionKeyMemoryStore;
      const config = message.config;
      await (await captureStore).configure(
        config.shareOwnerId ?? "",
        !!config.shareOwnerId &&
          !config.readOnly &&
          !config.enableClientEncryption &&
          !config.disableServiceWorker,
      );
      // Refreshed ahead of the configured check: a space added since this
      // worker booted must stop being answered locally right away.
      proxyRouter.setSpacePrefixes(config.spacePrefixes ?? []);
      const space = JSON.stringify([config.spaceFolderPath, config.githubRepo ?? null]);
      if (
        (isConfigured() && configuredSpace !== space) ||
        (configuring && configuringSpace !== space)
      ) {
        console.info("Space changed, reconfiguring service worker");
        proxyRouter.reset();
        // 作っている途中のものは、終わりの確かめ（generation）で止まる
        keyGeneration++;
        generation = keyGeneration;
        configuring = false;
      }
      if (isConfigured()) {
        console.info(
          "Service worker already configured, just updating configs",
        );
        proxyRouter.syncEngine!.setSyncConfig({
          syncDocuments: config.syncDocuments,
          syncIgnore: config.syncIgnore,
        });

        return;
      } else {
        console.info("Service being configured with", config);
      }
      if (configuring) {
        console.info("Configuration already in progress, skipping");
        return;
      }
      configuring = true;
      configuringSpace = space;
      const configureStart = performance.now();
      setTimeout(() => {
        configuring = false;
      }, 5000);
      try {
        if (config.enableClientEncryption) {
          if (!encryptionKey) {
            console.error(
              "Supposed to use encryption, but no phrase set yet, auth error",
            );
            broadcastMessage({
              type: "auth-error",
              message: "Re-authentication required, redirecting...",
              actionOrRedirectHeader: ".auth",
            });
            return;
          }
        }

        const spaceFolderPath = config.spaceFolderPath;
        const dbName = await deriveDbName(
          "files",
          spaceFolderPath,
          baseURI,
          encryptionKey,
        );

        if (config.logPush) {
          setInterval(() => {
            void logger.postToServer(".logs", "service_worker");
          }, 1000);
        }

        let kv: KvPrimitives = new IndexedDBKvPrimitives(dbName);
        await (kv as IndexedDBKvPrimitives).init();
        console.log("Using IndexedDB database", dbName);

        if (encryptionKey) {
          kv = new EncryptedKvPrimitives(kv, encryptionKey);
          await (kv as EncryptedKvPrimitives).init();
          console.log("Enabled client-side encryption for synced files");
        }

        const local = new DataStoreSpacePrimitives(kv);

        // vault-web: ノートの読み書きの先を SilverBullet のサーバーから GitHub に替える。
        // まだ GitHub に繋いでいなければ、同梱した標準ライブラリだけを持つ空の保存先にする
        // （画面は開ける。ノートの一覧は空で、アカウントのページから繋げる）
        const remote = new GitHubSpacePrimitives(
          `${baseURI}/api/gh`,
          `${baseURI}/_base_fs`,
          config.githubRepo ?? { owner: "", repo: "", branch: "", disconnected: true },
          kv,
          local,
        );
        // まだ繋いでいないときは、画面の言語に合った見本（デモ）を出す
        remote.setUiLanguage(config.uiLanguage ?? "ja");

        const syncEngine = new SyncEngine(kv, local, remote);
        syncEngine.setSyncConfig({
          syncDocuments: config.syncDocuments,
          syncIgnore: config.syncIgnore,
        });
        const syncStartBegin = performance.now();
        await syncEngine.start();

        if (generation !== keyGeneration || workerLogout.active) {
          syncEngine.stop();
          return;
        }
        syncDatabaseName = dbName;
        configuredSpace = space;
        proxyRouter.configure(syncEngine);
        console.log(
          `[Boot] service worker configured in ${Math.round(
            performance.now() - configureStart,
          )}ms (sync engine start: ${Math.round(
            performance.now() - syncStartBegin,
          )}ms)`,
        );

        proxyRouter.off(proxyRouterHandlers);
        proxyRouter.on(proxyRouterHandlers);
        syncEngine.on({
          syncProgress: (status) => {
            broadcastMessage({
              type: "sync-status",
              status,
            });
          },
          syncConflict: (path) => {
            console.warn("Sync conflict detected:", path);
            broadcastMessage({
              type: "sync-conflict",
              path,
            });
          },
          suppressedDeletion: (path) => {
            broadcastMessage({
              type: "suppressed-deletion",
              path,
            });
          },
          spaceSyncComplete: (operations) => {
            broadcastMessage({
              type: "space-sync-complete",
              operations,
            });
          },
          fileSyncComplete: (path, operations) => {
            broadcastMessage({
              type: "file-sync-complete",
              path,
              operations,
            });
          },
          fileSynced: (path) => {
            broadcastMessage({
              type: "file-synced",
              path,
            });
          },
          syncError: (error, path) => {
            broadcastMessage({
              type: "sync-error",
              message: error.message,
              path,
            });
          },
        });
      } finally {
        configuring = false;
      }
      break;
    }
  }
});

function broadcastMessage(message: ServiceWorkerSourceMessage) {
  // @ts-expect-error: service worker API
  const clients: any = self.clients;
  clients
    .matchAll({
      type: "window",
    })
    .then((clients: any[]) => {
      clients.forEach((client) => {
        client.postMessage(message);
      });
      if (clients.length === 0) {
        console.info(
          "No clients are listening for messages, dropping message",
          message,
        );
      }
    });
}

const throttledServiceWorkerStarted = throttleImmediately(() => {
  broadcastMessage({
    type: "service-worker-started",
  });
}, 100);

self.addEventListener("fetch", (event: any) => {
  if (!isConfigured()) {
    throttledServiceWorkerStarted();
  }

  if (isShareTarget(event.request, basePathName, location.origin)) {
    event.respondWith(
      captureStore.then(async (store) => {
        await refreshShareEligibility(store, `${baseURI}/.config`);
        return handleShareTarget(event.request, basePathName, store);
      }),
    );
    return;
  }

  const url = new URL(event.request.url);
  const captureId = url.searchParams.get("capture");
  if (
    event.request.mode === "navigate" &&
    url.origin === location.origin &&
    url.pathname === `${basePathName}/` &&
    captureId
  ) {
    event.respondWith(
      (async () => {
        const store = await captureStore;
        const config = await store.getConfiguration();
        if (config && (await store.get(captureId, config.ownerId))) {
          const shell = await caches.match(precacheFiles["/"]);
          if (shell) return shell;
        }
        return fetch(event.request);
      })(),
    );
    return;
  }

  proxyRouter.onFetch(event);
});

self.addEventListener("install", (event: any) => {
  console.log("Installing service worker...");
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      console.log("Now pre-caching client files");
      // vault-web: 1つのファイルが 404 でも、Service Worker 全体を止めない。
      // まとめて addAll すると、1つの失敗で全部が入らず、画面が真っ白になる（2026-11-09）
      const failed = (
        await Promise.allSettled(
          Object.values<string>(precacheFiles).map(async (url) => {
            const response = await fetch(new Request(url, { cache: "reload" }));
            if (!response.ok) throw new Error(`${response.status} ${url}`);
            await cache.put(url, response);
          }),
        )
      ).filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        console.error(
          `Failed to pre-cache ${failed.length} client files`,
          failed.map((result) => String((result as PromiseRejectedResult).reason)),
        );
      } else {
        console.log(Object.keys(precacheFiles).length, "client files cached");
      }
      // @ts-expect-error: Force the waiting service worker to become the active service worker
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event: any) => {
  console.log("Activating new service worker!");

  if (!isConfigured()) {
    throttledServiceWorkerStarted();
  }

  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log("Removing old cache", cacheName);
            return caches.delete(cacheName);
          }
        }),
      );
      // @ts-expect-error: Take control of all clients as soon as the service worker activates
      await clients.claim();
    })(),
  );
});

console.log("Service worker loaded");

function isConfigured() {
  return !!proxyRouter.syncEngine;
}
