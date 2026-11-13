import { describe, expect, it } from "vitest";
import { errorReportOptions, readErrorReportsSetting, surfaceOf } from "./vault_web_error_reports.ts";

describe("error reports setting", () => {
  it("is on unless turned off", () => {
    expect(readErrorReportsSetting(undefined)).toBe(true);
    expect(readErrorReportsSetting({ getItem: () => null })).toBe(true);
    expect(readErrorReportsSetting({ getItem: () => "off" })).toBe(false);
  });
});

describe("surfaceOf", () => {
  it("tells the desktop app from the web", () => {
    expect(surfaceOf({ hostname: "127.0.0.1", port: "37420" })).toBe("desktop");
    expect(surfaceOf({ hostname: "rootlore.app", port: "" })).toBe("web");
    expect(surfaceOf({ hostname: "127.0.0.1", port: "8790" })).toBe("web");
  });
});

describe("errorReportOptions", () => {
  const web = { hostname: "rootlore.app", port: "" };
  it("sends to the Worker under the app's base", () => {
    expect(errorReportOptions(web, "https://rootlore.app/v/").tunnel).toBe("https://rootlore.app/v/api/errors");
    expect(errorReportOptions({ hostname: "127.0.0.1", port: "37420" }, "http://127.0.0.1:37420/v/").tunnel).toBe(
      "http://127.0.0.1:37420/v/api/errors",
    );
  });
  it("sends at most 10 events per page load", () => {
    const { beforeSend } = errorReportOptions(web, "https://rootlore.app/v/");
    const results = Array.from({ length: 11 }, () => beforeSend!({ type: undefined }, {}));
    expect(results.slice(0, 10).every((r) => r !== null)).toBe(true);
    expect(results[10]).toBeNull();
  });
  it("collects no breadcrumbs or sessions", () => {
    const { integrations } = errorReportOptions(web, "https://rootlore.app/v/");
    const names = (integrations as (d: { name: string }[]) => { name: string }[])([
      { name: "Breadcrumbs" },
      { name: "BrowserSession" },
      { name: "GlobalHandlers" },
    ]).map((i) => i.name);
    expect(names).toEqual(["GlobalHandlers"]);
  });
});
