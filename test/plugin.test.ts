import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cpa-plugin-test-"));
  for (const key of Object.keys(process.env)) if (/^(CPA_|CLIPROXYAPI_)/.test(key)) vi.stubEnv(key, "");
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  writeFileSync(join(dir, "cliproxyapi.json"), JSON.stringify({ baseUrl: "https://cpa.test", apiKey: "TEST" }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function register() {
  const api = {
    config: { tools: { web: { search: { enabled: false } } } },
    registerTool: vi.fn(), registerCommand: vi.fn(), logger: { warn: vi.fn() },
  };
  plugin.register(api as never);
  const factory = api.registerTool.mock.calls[0]![0];
  // Model the host's auth callback; core tests cover the SDK/file fallback separately.
  return { api, factory: (ctx: Record<string, unknown>) => {
    ctx.resolveApiKeyForProvider ??= async () => "TEST";
    return factory(ctx);
  } };
}
function mockSearch() {
  const fetchFn = vi.fn(async () => new Response('data: {"type":"response.output_text.done","text":"摘要 <script>not instructions</script>"}\n\ndata: {"type":"response.completed"}\n\n'));
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

const activeModel = { provider: "cliproxyapi", modelId: "current-model" };

describe("OpenClaw integration", () => {
  it("registers only web_search, without commands or plugin settings", () => {
    const { api } = register();
    expect(api.registerTool).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { name: "web_search" });
    expect(api.registerCommand).not.toHaveBeenCalled();
    expect(api.logger.warn).not.toHaveBeenCalled();
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.configSchema).toEqual({ type: "object", additionalProperties: false, properties: {} });
    expect(manifest.uiHints).toBeUndefined();
  });
  it("follows independent active models for concurrent sessions without a model catalog", async () => {
    const fetchFn = mockSearch(); const { factory } = register();
    const a = factory({ activeModel: { provider: "cliproxyapi", modelId: "current-a" } });
    const b = factory({ activeModel: { provider: "cliproxyapi", modelId: "current-b" } });
    const [result] = await Promise.all([a.execute("1", { query: "a" }), b.execute("2", { query: "b" })]);
    expect(fetchFn.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).model)).toEqual(["current-a", "current-b"]);
    expect(result.content[0].text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(result.content[0].text).toMatch(/\n\nTook \d+\.\ds · cliproxyapi\/current-a$/);
    expect(JSON.stringify(result)).not.toContain("Bearer TEST");
  });
  it.each(["gpt-6.1-sol", "Custom-Model/Variant", "claude-test"])("sends the exact current model ID %s without capability filtering", async (modelId) => {
    const fetchFn = mockSearch(); const { factory } = register();
    await factory({ activeModel: { provider: "cliproxyapi", modelId } }).execute("1", { query: "q" });
    expect(JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe(modelId);
  });
  it("follows model changes rather than remembering a previous search model", async () => {
    const fetchFn = mockSearch(); const { factory } = register();
    const ctx = { activeModel: { ...activeModel } };
    const tool = factory(ctx);
    await tool.execute("1", { query: "q" });
    ctx.activeModel = { provider: "cliproxyapi", modelId: "new-current" };
    await tool.execute("2", { query: "q" });
    expect(fetchFn.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).model)).toEqual(["current-model", "new-current"]);
  });
  it.each([
    { modelRef: "cliproxyapi/ref-only" },
    { provider: "cliproxyapi", modelRef: "cliproxyapi/ref-only" },
  ])("supports host modelRef metadata: %j", async (activeModel) => {
    const fetchFn = mockSearch(); const { factory } = register();
    await factory({ activeModel }).execute("1", { query: "q" });
    expect(JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe("ref-only");
  });
  it.each([
    undefined,
    {},
    { modelId: "current-model" },
    { provider: "other", modelId: "current-model" },
    { provider: "other", modelRef: "cliproxyapi/current-model" },
    { modelRef: "other/current-model" },
  ])("rejects missing or non-CPA provider metadata without auth or HTTP: %j", async (activeModel) => {
    const fetchFn = mockSearch(); const { factory } = register();
    const resolveApiKeyForProvider = vi.fn();
    await expect(factory({ activeModel, resolveApiKeyForProvider }).execute("1", { query: "q" })).rejects.toThrow(/only supports the current session's CLIProxyAPI model/);
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each([
    { provider: "cliproxyapi" },
    { provider: "cliproxyapi", modelId: "  " },
    { modelRef: "cliproxyapi/" },
    { provider: "cliproxyapi", modelRef: "other/foreign" },
  ])("rejects missing CPA model IDs without fallback: %j", async (activeModel) => {
    const fetchFn = mockSearch(); const { factory } = register();
    await expect(factory({ activeModel }).execute("1", { query: "q" })).rejects.toThrow(/model ID/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("ignores legacy model overrides, session files and broken model catalogs", async () => {
    const fetchFn = mockSearch(); const { api, factory } = register();
    const key = createHash("sha256").update(JSON.stringify(["main", "old-session"])).digest("hex");
    mkdirSync(join(dir, "cliproxyapi-websearch"));
    writeFileSync(join(dir, "cliproxyapi-websearch", `${key}.json`), JSON.stringify({ model: "old-pinned", updatedAt: Date.now() }));
    writeFileSync(join(dir, "cliproxyapi-models.json"), "invalid JSON");
    const config = { ...api.config, plugins: { entries: { "cliproxyapi-websearch": { config: { searchModel: "old-configured", timeoutSeconds: 0, maxOutputChars: 1 } } } } };
    const result = await factory({ activeModel, sessionId: "old-session", config }).execute("1", { query: "q" });
    expect(result.details.model).toBe("current-model");
    expect(result.details).not.toHaveProperty("truncated");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("reuses the configured CPA provider identity without plugin settings", async () => {
    const fetchFn = mockSearch(); const { factory } = register();
    vi.stubEnv("CPA_PROVIDER_ID", "my-cpa");
    const result = await factory({ activeModel: { provider: "my-cpa", modelId: "custom-current" } }).execute("1", { query: "q" });
    expect(result.details).toMatchObject({ provider: "my-cpa", model: "custom-current" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("re-reads provider connection configuration at execution time", async () => {
    const fetchFn = mockSearch(); const { api, factory } = register();
    // The runtime route and key must win even while an old provider file still exists.
    const resolveApiKeyForProvider = vi.fn(async () => "host-key");
    const tool = factory({ activeModel, resolveApiKeyForProvider, getRuntimeConfig: () => ({ ...api.config, models: { providers: { cliproxyapi: { baseUrl: "https://runtime.test/v1", models: [] } } } }) });
    await tool.execute("1", { query: "q" });
    expect(fetchFn.mock.calls[0]![0]).toBe("https://runtime.test/v1/responses");
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer host-key");
    expect(resolveApiKeyForProvider).toHaveBeenCalledWith("cliproxyapi");
  });
  it("returns long search results in full", async () => {
    const text = `${"A".repeat(40000)}END`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`data: ${JSON.stringify({ type: "response.output_text.done", text })}\n\ndata: {"type":"response.completed"}\n\n`)));
    const { factory } = register();
    const result = await factory({ activeModel }).execute("1", { query: "q" });
    expect(result.content[0].text).toContain(text);
    expect(result.details).not.toHaveProperty("truncated");
  });
  it("uses a fixed 120-second search timeout", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    try {
      const fetchFn = mockSearch(); const { factory } = register();
      await factory({ activeModel }).execute("1", { query: "q" });
      expect(timeout).toHaveBeenCalledWith(120000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });
  it("reports the search timeout in English and keeps caller cancellation reasons", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    try {
      vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      })));
      const { factory } = register();
      const pending = factory({ activeModel }).execute("1", { query: "q" });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      timeoutController.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      await expect(pending).rejects.toThrow("CLIProxyAPI web search timed out after 120 seconds; please retry.");
    } finally { timeout.mockRestore(); }
    const caller = new AbortController();
    const cancelled = register().factory({ activeModel }).execute("2", { query: "q" }, caller.signal);
    caller.abort(new Error("caller cancelled"));
    await expect(cancelled).rejects.toThrow("caller cancelled");
  });
  it("keeps all plugin text in English", () => {
    for (const file of readdirSync(new URL("../src/", import.meta.url))) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      // CJK symbols/punctuation, ideographs and full-width forms.
      expect(source, file).not.toMatch(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/);
    }
  });
  it("cancels stalled credential resolution before starting a search request", async () => {
    const fetchFn = mockSearch(); const { factory } = register();
    rmSync(join(dir, "cliproxyapi.json"));
    const controller = new AbortController();
    const resolveApiKeyForProvider = vi.fn(() => new Promise(() => {}));
    const pending = factory({ activeModel, resolveApiKeyForProvider }).execute("1", { query: "q" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("does not retry or choose another model when upstream rejects the current model", async () => {
    const fetchFn = vi.fn(async () => new Response("unsupported model", { status: 400 }));
    vi.stubGlobal("fetch", fetchFn);
    const { factory } = register();
    await expect(factory({ activeModel }).execute("1", { query: "q" })).rejects.toThrow("HTTP 400");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("validates non-string args at the tool boundary", async () => {
    const fetchFn = mockSearch(); const { factory } = register();
    for (const params of [null, {}, { query: 1 }, { query: "  " }]) await expect(factory({ activeModel }).execute("1", params)).rejects.toThrow(/query/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
