import { afterEach, expect, test, vi } from "vitest";
import { waitForControl } from "./vault_web_service_worker.ts";

const never = new Promise<boolean>(() => {});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("registration failure stops the wait at once instead of waiting for the timeout", async () => {
  vi.useFakeTimers();
  const result = waitForControl(never, Promise.resolve(false), 15000);
  await vi.advanceTimersByTimeAsync(0);
  await expect(result).resolves.toBe(false);
});

test("a registered worker that takes control resolves true", async () => {
  await expect(
    waitForControl(Promise.resolve(true), Promise.resolve(true), 15000),
  ).resolves.toBe(true);
});

test("a registered worker that never takes control times out with false", async () => {
  vi.useFakeTimers();
  let settled: boolean | undefined;
  void waitForControl(never, Promise.resolve(true), 15000).then((v) => (settled = v));
  await vi.advanceTimersByTimeAsync(14999);
  expect(settled).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(false);
});

// client/debug.ts が登録する unhandledrejection のハンドラを取り出す
async function rejectionHandler(): Promise<(event: { reason: unknown }) => void> {
  let handler: ((event: { reason: unknown }) => void) | undefined;
  vi.stubGlobal("addEventListener", (type: string, fn: typeof handler) => {
    if (type === "unhandledrejection") handler = fn;
  });
  vi.resetModules();
  await import("./debug.ts");
  return handler!;
}

test("unhandled rejection handler does not throw before the client exists", async () => {
  const handler = await rejectionHandler();
  vi.stubGlobal("client", undefined);
  expect(() => handler({ reason: new Error("x") })).not.toThrow();
});

test("unhandled rejection handler waits until the client has its UI", async () => {
  const handler = await rejectionHandler();
  const reportError = vi.fn();
  vi.stubGlobal("client", { reportError });
  handler({ reason: new Error("x") });
  expect(reportError).not.toHaveBeenCalled();
});

test("unhandled rejection handler skips an empty reason", async () => {
  const handler = await rejectionHandler();
  const reportError = vi.fn();
  vi.stubGlobal("client", { ui: {}, reportError });
  handler({ reason: undefined });
  expect(reportError).not.toHaveBeenCalled();
});

test("unhandled rejection handler passes the reason once the client is ready", async () => {
  const handler = await rejectionHandler();
  const reportError = vi.fn();
  const error = new Error("x");
  vi.stubGlobal("client", { ui: {}, reportError });
  handler({ reason: error });
  expect(reportError).toHaveBeenCalledWith(error);
});
