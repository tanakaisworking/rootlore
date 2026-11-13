import { afterEach, expect, test, vi } from "vitest";

vi.mock("./codemirror/editor_state.ts", () => ({}));
vi.mock("./components/widget_sandbox_iframe.ts", () => ({
  broadcastReload: () => {},
  createWidgetSandboxIFrame: () => {},
  mountIFrame: () => {},
  prepareSandboxIFrame: () => {},
}));

const { Client } = await import("./client.ts");

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a failed direct page-list fetch keeps the last trustworthy list", async () => {
  const viewDispatch = vi.fn();
  const fetchFileList = vi.fn();
  const client = {
    objectIndex: {
      isIndexAvailable: async () => false,
    },
    space: {
      fetchPageList: async () => {
        throw new Error("Offline");
      },
      spacePrimitives: { fetchFileList },
    },
    ui: {
      flashNotification: vi.fn(),
      viewDispatch,
    },
  };

  await Client.prototype.updatePageListCache.call(client);

  expect(viewDispatch).not.toHaveBeenCalled();
  expect(fetchFileList).not.toHaveBeenCalled();
});

test("an unsaved editor prevents the tab from unloading", () => {
  let beforeUnload: ((event: BeforeUnloadEvent) => void) | undefined;
  vi.stubGlobal(
    "addEventListener",
    vi.fn((name: string, listener: (event: BeforeUnloadEvent) => void) => {
      if (name === "beforeunload") beforeUnload = listener;
    }),
  );
  const register = (
    Client.prototype as unknown as {
      registerUnsavedChangesWarning?: () => void;
    }
  ).registerUnsavedChangesWarning;
  expect(register).toBeTypeOf("function");
  if (!register) return;
  const client = { ui: { viewState: { unsavedChanges: true } } };
  register.call(client);
  const event = {
    preventDefault: vi.fn(),
    returnValue: false,
  } as unknown as BeforeUnloadEvent;

  beforeUnload!(event);

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.returnValue).toBe(true);
});


test.each([false, true])("Web update notification is shown only outside the desktop app (desktop=%s)", async (desktop) => {
  if (desktop) vi.stubGlobal("__TAURI_INTERNALS__", { invoke: vi.fn() });
  else vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  const client = {
    ui: { flashNotification: vi.fn() },
    eventHook: { dispatchEvent: vi.fn(async () => {}) },
    versionMismatchNotified: false,
  };
  await Client.prototype.handleServiceWorkerMessage.call(client as any, { type: "server-version", serverVersion: "different-build" });
  expect(client.ui.flashNotification).toHaveBeenCalledTimes(desktop ? 0 : 1);
  expect(client.eventHook.dispatchEvent).toHaveBeenCalled();
});
