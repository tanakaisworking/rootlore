import { expect, test, vi } from "vitest";

test("a failed lazy import is retried after the network returns", async () => {
  vi.resetModules();
  let imports = 0;
  const api = {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 10 10"><g/></svg>' })),
  };
  vi.doMock("mermaid", () => {
    imports++;
    if (imports === 1) throw new Error("offline");
    return { default: api };
  });
  try {
    const { renderMermaid } = await import("./vault_web_mermaid.ts");
    await expect(renderMermaid("flowchart LR\nA --> B", false)).rejects.toThrow();
    await expect(
      renderMermaid("flowchart LR\nA --> B", false),
    ).resolves.toContain("<svg");
    expect(imports).toBe(2);
    expect(api.render).toHaveBeenCalledOnce();
  } finally {
    vi.doUnmock("mermaid");
  }
});
