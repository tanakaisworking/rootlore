import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEvent,
  handleErrors,
  parseDsn,
  readCapped,
  redactMessage,
  redactUrl,
  reportWorkerError,
  rewriteEnvelope,
} from "./errors";

const DSN = "https://abc123@o1.ingest.sentry.io/42";

afterEach(() => vi.restoreAllMocks());

const exceptionEvent = (value: unknown, type = "TypeError") => ({ exception: { values: [{ type, value }] } });

describe("parseDsn", () => {
  it("reads key, host and project", () => {
    expect(parseDsn(DSN)).toMatchObject({ key: "abc123", host: "o1.ingest.sentry.io", projectId: "42" });
  });
  it("rejects missing or malformed values", () => {
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn("")).toBeNull();
    expect(parseDsn("http://abc@host/1")).toBeNull();
    expect(parseDsn("https://host/1")).toBeNull();
    expect(parseDsn("https://abc@host/x")).toBeNull();
  });
});

describe("redactUrl", () => {
  it("keeps bundled files", () => {
    expect(redactUrl("https://rootlore.app/v/.client/client.js?x=1#y")).toBe("https://rootlore.app/v/.client/client.js");
    expect(redactUrl("http://127.0.0.1:37420/v/service_worker.js")).toBe("http://127.0.0.1:37420/v/service_worker.js");
  });
  it("hides page locations, queries and hashes", () => {
    expect(redactUrl("https://rootlore.app/v/Projects/Secret%20plan")).toBe("https://rootlore.app/v/[page]");
    expect(redactUrl("https://rootlore.app/v/#Secret")).toBe("https://rootlore.app/v/[page]");
    expect(redactUrl("https://rootlore.app/api/gh/repos/me/notes/contents/a.md")).toBe("https://rootlore.app/[page]");
    expect(redactUrl("blob:https://rootlore.app/1234")).toBe("blob:[url]");
    expect(redactUrl("not a url")).toBe("[url]");
  });
});

describe("redactMessage", () => {
  it("hides quoted text, paths, file names and URLs", () => {
    expect(redactMessage('Page "Secret plan" not found')).toBe('Page "[redacted]" not found');
    expect(redactMessage("ページ「秘密の計画」がありません")).toBe('ページ"[redacted]"がありません');
    expect(redactMessage("Duplicate anchor on pages: Projects/Secret, Archive/Old")).toBe(
      "Duplicate anchor on pages: [path] [path]",
    );
    expect(redactMessage("Could not load Secret.md now")).toBe("[file] now");
    expect(redactMessage("Could not load Secret plan.md now")).toBe("[file] now");
    expect(redactMessage("Failed to read: 会議 メモ.md")).toBe("Failed to read: [file]");
    expect(redactMessage("Script https://rootlore.app/v/Secret load failed")).toBe(
      "Script https://rootlore.app/v/[page] load failed",
    );
    expect(redactMessage("Script http://127.0.0.1:37420/v/service_worker.js load failed")).toBe(
      "Script http://127.0.0.1:37420/v/service_worker.js load failed",
    );
  });
  it("keeps identifiers in engine messages", () => {
    expect(redactMessage("Cannot read properties of undefined (reading 'flashNotification')")).toBe(
      "Cannot read properties of undefined (reading 'flashNotification')",
    );
    expect(redactMessage("missing 'Secret plan'")).toBe('missing "[redacted]"');
    expect(redactMessage("x is not a function")).toBe("x is not a function");
  });
  it("caps the length", () => {
    expect(redactMessage("a".repeat(2000))).toHaveLength(500);
  });
});

describe("buildEvent", () => {
  it("keeps only allowed fields", () => {
    const event = buildEvent({
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1,
      level: "error",
      environment: "production",
      release: "rootlore@2.12.1-abc",
      user: { ip_address: "1.2.3.4" },
      extra: { note: "secret" },
      breadcrumbs: [{ message: "secret" }],
      contexts: { note: { text: "secret" } },
      tags: { surface: "web", page: "Secret" },
      transaction: "/v/Secret",
      request: { url: "https://rootlore.app/v/Secret", headers: { Cookie: "x" }, query_string: "a=b" },
      exception: {
        values: [{
          type: "TypeError",
          value: "x is not a function",
          mechanism: { type: "onerror", handled: false, data: { secret: 1 } },
          stacktrace: {
            frames: [{
              function: "open",
              abs_path: "https://rootlore.app/v/.client/client.js?v=1",
              lineno: 1,
              colno: 2,
              vars: { text: "secret" },
              context_line: "secret",
            }],
          },
        }],
      },
    }, "Mozilla/5.0");
    expect(JSON.parse(JSON.stringify(event))).toEqual({
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1,
      platform: "javascript",
      level: "error",
      environment: "production",
      release: "rootlore@2.12.1-abc",
      tags: { surface: "web" },
      request: { url: "https://rootlore.app/v/[page]", headers: { "User-Agent": "Mozilla/5.0" } },
      exception: {
        values: [{
          type: "TypeError",
          value: "x is not a function",
          mechanism: { type: "onerror", handled: false },
          stacktrace: { frames: [{ function: "open", abs_path: "https://rootlore.app/v/.client/client.js", lineno: 1, colno: 2 }] },
        }],
      },
    });
  });
  it("ignores a worker surface sent from the page", () => {
    expect(buildEvent({ ...exceptionEvent("x"), tags: { surface: "worker" } })?.tags).toBeUndefined();
  });
  it("keeps worker code paths in frames", () => {
    const event = buildEvent({
      exception: { values: [{ type: "Error", stacktrace: { frames: [{ filename: "worker/index.ts" }, { filename: "Secret plan" }] } }] },
    });
    expect(JSON.stringify(event)).toContain('"filename":"worker/index.ts"');
    expect(JSON.stringify(event)).not.toContain("Secret");
  });
  it("drops the message of errors the app throws", () => {
    const event = buildEvent(exceptionEvent("Cannot restore: could not open Secret plan.", "Error"));
    expect(JSON.stringify(event)).not.toContain("Secret");
  });
  it("rejects non-exception and malformed events without throwing", () => {
    expect(buildEvent({ message: "hello" })).toBeNull();
    expect(buildEvent(null)).toBeNull();
    expect(buildEvent({ exception: { values: [null] } })).toBeNull();
    expect(buildEvent({ exception: { values: {} } })).toBeNull();
    expect(buildEvent({ exception: { values: ["x"] } })).toBeNull();
    expect(buildEvent({ exception: { values: [{ type: "TypeError", stacktrace: { frames: {} } }] } })).not.toBeNull();
    expect(buildEvent({ exception: { values: [{ type: "TypeError", stacktrace: { frames: [null, 1] } }] } })).not.toBeNull();
  });
});

describe("rewriteEnvelope", () => {
  const dsn = parseDsn(DSN)!;
  it("keeps the first event only and uses the Worker's DSN", () => {
    const event = JSON.stringify(exceptionEvent("x is not a function"));
    const body = [
      JSON.stringify({ dsn: "https://rootlore@errors.rootlore.invalid/0", event_id: "1" }),
      JSON.stringify({ type: "session" }),
      JSON.stringify({ sid: "x" }),
      ...Array.from({ length: 3 }, () => [JSON.stringify({ type: "event" }), event]).flat(),
    ].join("\n");
    const out = rewriteEnvelope(body, dsn)!.split("\n");
    expect(out).toHaveLength(3);
    expect(JSON.parse(out[0]!).dsn).toBe(DSN);
    expect(JSON.parse(out[2]!).exception.values[0].value).toBe("x is not a function");
  });
  it("rejects envelopes with nothing to send or with non-JSON items", () => {
    expect(rewriteEnvelope("not json", dsn)).toBeNull();
    expect(rewriteEnvelope(`{}\n${JSON.stringify({ type: "session" })}\n{}`, dsn)).toBeNull();
    expect(rewriteEnvelope(`{}\n${JSON.stringify({ type: "attachment" })}\nraw bytes`, dsn)).toBeNull();
    expect(rewriteEnvelope(`{}\n${JSON.stringify({ type: "event" })}\n{"message":"spam"}`, dsn)).toBeNull();
  });
});

describe("readCapped", () => {
  it("reads up to the limit in bytes", async () => {
    expect(await readCapped(new Request("https://x/", { method: "POST", body: "abc" }), 3)).toBe("abc");
    // 3 バイトの文字 2 つは 6 バイト
    expect(await readCapped(new Request("https://x/", { method: "POST", body: "ああ" }), 5)).toBeNull();
  });
  it("refuses a declared length over the limit without reading", async () => {
    const req = new Request("https://x/", { method: "POST", body: "abc", headers: { "Content-Length": "999" } });
    expect(await readCapped(req, 10)).toBeNull();
  });
});

describe("handleErrors", () => {
  const envelope = `{}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(exceptionEvent("boom"))}`;
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://rootlore.app/v/api/errors", { method: "POST", body, headers });

  it("drops reports when no DSN is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await handleErrors(post(envelope), undefined)).status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("forwards to the Sentry envelope endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    expect((await handleErrors(post(envelope, { "User-Agent": "UA" }), DSN)).status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://o1.ingest.sentry.io/api/42/envelope/?sentry_key=abc123&sentry_version=7");
    expect(String(init?.body)).toContain('"value":"boom"');
    expect(String(init?.body)).toContain('"User-Agent":"UA"');
  });
  it("answers 502 when Sentry cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await handleErrors(post(envelope), DSN)).status).toBe(502);
  });
  it("refuses pages on other sites", async () => {
    expect((await handleErrors(post(envelope, { Origin: "https://evil.example" }), DSN)).status).toBe(403);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    expect((await handleErrors(post(envelope, { Origin: "https://rootlore.app" }), DSN)).status).toBe(200);
  });
  it("applies the rate limit", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const res = await handleErrors(post(envelope, { "CF-Connecting-IP": "1.2.3.4" }), DSN, limiter);
    expect(res.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "1.2.3.4" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("rejects other methods, oversized bodies and bad envelopes", async () => {
    expect((await handleErrors(new Request("https://rootlore.app/v/api/errors"), DSN)).status).toBe(405);
    expect((await handleErrors(post("x".repeat(200_001)), DSN)).status).toBe(413);
    expect((await handleErrors(post("nope"), DSN)).status).toBe(400);
    expect((await handleErrors(post(`{}\n{"type":"event"}\n{"exception":{"values":[null]}}`), DSN)).status).toBe(400);
  });
});

describe("reportWorkerError", () => {
  it("sends a sanitized event", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await reportWorkerError(
      new Error("GitHub: Secret/plan.md was not returned"),
      new Request("https://rootlore.app/api/gh/repos/a/b/contents/Secret.md?x=1"),
      DSN,
    );
    const body = String(fetchSpy.mock.calls[0]![1]?.body);
    expect(body).not.toContain("Secret");
    const event = JSON.parse(body.split("\n")[2]!);
    expect(event.request).toEqual({ url: "https://rootlore.app/[page]" });
    expect(event.tags).toEqual({ surface: "worker" });
    expect(event.exception.values[0].type).toBe("Error");
    expect(event.exception.values[0].value).toBe("GitHub: [path] was not returned");
  });
  it("does nothing without a DSN", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await reportWorkerError(new Error("x"), new Request("https://rootlore.app/"), undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
