
// Rootlore のデスクトップ版: MCP の道具の中身。アプリ（Rust）が eval で handle を呼び、答えを mcp_result で返す。
// ノートは Rootlore の本体（globalThis.client）がブラウザの中に持っている分を使う（GitHub には問い合わせない）
(() => {
  // 画面は、公開中のサイト（rootlore.app）か、アプリが同梱した手元のサーバーのどちらでも動く
  const host = location.host;
  if (window.top !== window || (host !== "rootlore.app" && host !== "127.0.0.1:37420" && host !== "localhost:37420")) return;
  const cache = new Map(); // path -> { lastModified, text }
  const decoder = new TextDecoder();
  const client = () => {
    if (!globalThis.client || !globalThis.client.space) throw new Error("Rootlore がまだ起動中です。少し待ってからもう一度試してください。");
    return globalThis.client;
  };
  const notes = async () => {
    const files = await client().space.spacePrimitives.fetchFileList();
    return files.filter((f) => f.name.endsWith(".md") && !f.name.startsWith("Library/"));
  };
  const readText = async (meta) => {
    const hit = cache.get(meta.name);
    if (hit && hit.lastModified === meta.lastModified) return hit.text;
    const { data } = await client().space.spacePrimitives.readFile(meta.name);
    const text = decoder.decode(data);
    cache.set(meta.name, { lastModified: meta.lastModified, text });
    return text;
  };
  const tools = {
    async list_notes({ prefix = "", limit = 500 } = {}) {
      const list = (await notes()).filter((f) => f.name.startsWith(prefix)).map((f) => f.name);
      return { total: list.length, notes: list.slice(0, limit) };
    },
    async read_note({ path }) {
      if (!path) throw new Error("path を指定してください（例: 0_AgentBrain/INDEX.md）");
      const name = path.endsWith(".md") ? path : path + ".md";
      const meta = (await notes()).find((f) => f.name === name);
      if (!meta) throw new Error("ノートが見つかりません: " + name);
      return { path: name, text: await readText(meta) };
    },
    async search_notes({ query, limit = 20, prefix = "" }) {
      const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) throw new Error("query を指定してください");
      const started = performance.now();
      const list = (await notes()).filter((f) => f.name.startsWith(prefix));
      const results = [];
      // 一度に読みすぎないよう、少しずつ読む
      for (let i = 0; i < list.length; i += 50) {
        const batch = list.slice(i, i + 50);
        const texts = await Promise.all(batch.map(readText));
        batch.forEach((meta, j) => {
          const text = texts[j];
          const hay = (meta.name + "\n" + text).toLowerCase();
          if (!words.every((w) => hay.includes(w))) return;
          const lines = text.split("\n");
          const hits = [];
          lines.forEach((line, n) => {
            const l = line.toLowerCase();
            if (words.some((w) => l.includes(w)) && hits.length < 3) hits.push({ line: n + 1, text: line.slice(0, 200) });
          });
          const score = words.reduce((s, w) => s + (meta.name.toLowerCase().includes(w) ? 5 : 0) + hay.split(w).length - 1, 0);
          results.push({ path: meta.name, score, hits });
        });
      }
      results.sort((a, b) => b.score - a.score);
      return { total: results.length, scanned: list.length, ms: Math.round(performance.now() - started), results: results.slice(0, limit) };
    },
  };
  window.__vwMcp = {
    async handle(id, name, argsJson) {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      try {
        const fn = tools[name];
        if (!fn) throw new Error("知らない道具です: " + name);
        const result = await fn(JSON.parse(argsJson || "{}"));
        await invoke("mcp_result", { id, ok: true, payload: JSON.stringify(result) });
      } catch (e) {
        await invoke("mcp_result", { id, ok: false, payload: String((e && e.message) || e) });
      }
    },
  };
})();
