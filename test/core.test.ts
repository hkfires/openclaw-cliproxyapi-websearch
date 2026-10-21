import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKeyForProvider as resolveHostApiKey } from "openclaw/plugin-sdk/agent-runtime";
import { resolveConnection, resolveHeaders } from "../src/config.js";
import { resolveResponsesEndpoint } from "../src/endpoint.js";
import { consumeSseStream, createSseParser } from "../src/sse.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveApiKeyForProvider: vi.fn(async () => { throw Object.assign(new Error("No host credential"), { code: "missing-provider-auth" }); }),
}));

const dirs: string[] = [];
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function state() {
  const dir = mkdtempSync(join(tmpdir(), "cpa-search-test-")); dirs.push(dir);
  for (const key of Object.keys(process.env)) if (/^(CPA_|CLIPROXYAPI_)/.test(key)) vi.stubEnv(key, "");
  return dir;
}

describe("endpoint", () => {
  it.each([
    // Keep these base-URL expectations aligned with the companion provider's resolveEndpoints.
    ["http://localhost:8317", "http://localhost:8317/v1/responses"],
    ["localhost:8317/v1/", "http://localhost:8317/v1/responses"],
    ["https://host/", "https://host/v1/responses"],
    ["https://host/proxy", "https://host/proxy/v1/responses"],
    ["https://host/proxy/v1/", "https://host/proxy/v1/responses"],
    ["https://host/backend-api", "https://host/v1/responses"],
    ["https://host/backend-api/", "https://host/v1/responses"],
    ["https://host/proxy/backend-api/", "https://host/proxy/v1/responses"],
    ["https://host/proxy//backend-api/", "https://host/proxy/v1/responses"],
    ["https://host/v1/backend-api", "https://host/v1/v1/responses"],
    ["https://host/backend-api/codex", "https://host/backend-api/codex/v1/responses"],
    ["https://host/codex", "https://host/codex/v1/responses"],
    ["https://host/v1/responses/", "https://host/v1/responses/v1/responses"],
  ])("normalizes provider base URL %s", (input, expected) => expect(resolveResponsesEndpoint(input)).toBe(expected));
  it.each(["", "file:///tmp", "ftp://host", "https://user:key@host", "https://host?token=key", "https://host/#x"])("rejects unsafe/ambiguous %s", (url) => expect(() => resolveResponsesEndpoint(url)).toThrow());
});

describe("configuration and credentials", () => {
  it("prefers the runtime provider address, then env/file defaults, with custom provider identity", () => {
    const dir = state();
    writeFileSync(join(dir, "cliproxyapi.json"), JSON.stringify({ providerId: "my-cpa", baseUrl: "http://file:8317", apiKey: "file-key" }));
    const cfg = { models: { providers: { "my-cpa": { baseUrl: "https://host/v1", models: [] } } } };
    expect(resolveConnection(cfg, dir)).toMatchObject({ provider: "my-cpa", endpoint: "https://host/v1/responses", apiKey: "file-key" });
    vi.stubEnv("CLIPROXYAPI_BASE_URL", "https://env"); vi.stubEnv("CPA_API_KEY", "env-key");
    expect(resolveConnection(cfg, dir)).toMatchObject({ endpoint: "https://host/v1/responses", apiKey: "env-key" });
    expect(resolveConnection({}, dir).endpoint).toBe("https://env/v1/responses");
    vi.stubEnv("CLIPROXYAPI_BASE_URL", "");
    expect(resolveConnection({}, dir).endpoint).toBe("http://file:8317/v1/responses");
  });
  it("normalizes legacy provider-file and environment addresses to the standard route", () => {
    const dir = state();
    writeFileSync(join(dir, "cliproxyapi.json"), JSON.stringify({ baseUrl: "https://host/proxy/backend-api", apiKey: "file-key" }));
    const cfg = { models: { providers: { cliproxyapi: { baseUrl: "https://host/proxy/v1", models: [] } } } };
    expect(resolveConnection(cfg, dir).endpoint).toBe("https://host/proxy/v1/responses");
    vi.stubEnv("CPA_BASE_URL", "https://env/backend-api/");
    expect(resolveConnection(cfg, dir).endpoint).toBe("https://host/proxy/v1/responses");
    expect(resolveConnection({}, dir).endpoint).toBe("https://env/v1/responses");
  });
  it("does not reflect malformed config secrets", () => {
    const dir = state(); writeFileSync(join(dir, "cliproxyapi.json"), '{"apiKey":"SECRET" bad}');
    expect(() => resolveConnection({}, dir)).toThrow(/无法读取/);
    try { resolveConnection({}, dir); } catch (error) { expect(String(error)).not.toContain("SECRET"); }
  });
  it("uses host config route without requiring the companion plugin", async () => {
    const dir = state();
    const cfg = { models: { providers: { cliproxyapi: { baseUrl: "https://configured/v1", models: [], headers: { "X-Custom": "test" } } } } };
    const conn = resolveConnection(cfg, dir);
    const resolver = vi.fn(async () => "host-key");
    const headers = await resolveHeaders(conn, cfg, { resolveApiKeyForProvider: resolver });
    expect(conn.endpoint).toBe("https://configured/v1/responses");
    expect(headers.get("authorization")).toBe("Bearer host-key");
    expect(headers.get("x-custom")).toBe("test");
    expect(resolver).toHaveBeenCalledWith("cliproxyapi");
  });
  it("prefers current host credentials over provider-file credentials", async () => {
    const resolver = vi.fn(async () => "current-key");
    const headers = await resolveHeaders({ provider: "cliproxyapi", endpoint: "https://host", apiKey: "old-key" }, {}, { resolveApiKeyForProvider: resolver });
    expect(headers.get("authorization")).toBe("Bearer current-key");
    expect(resolveHostApiKey).not.toHaveBeenCalled();
  });
  it("uses the host SDK before falling back to provider-file credentials", async () => {
    vi.mocked(resolveHostApiKey).mockResolvedValueOnce({ apiKey: "sdk-key", source: "test", mode: "api-key" });
    const headers = await resolveHeaders({ provider: "cliproxyapi", endpoint: "https://host", apiKey: "old-key" }, {}, { agentDir: "test-agent" });
    expect(headers.get("authorization")).toBe("Bearer sdk-key");
    expect(resolveHostApiKey).toHaveBeenCalledWith({ provider: "cliproxyapi", cfg: {}, agentDir: "test-agent", secretSentinels: false });
  });
  it("uses the companion provider's key when the host has no credential", async () => {
    const headers = await resolveHeaders({ provider: "cliproxyapi", endpoint: "https://host", apiKey: "file-key" }, {}, {});
    expect(headers.get("authorization")).toBe("Bearer file-key");
  });
  it("does not hide host credential errors by silently using another key", async () => {
    vi.mocked(resolveHostApiKey).mockRejectedValueOnce(new Error("SECRET"));
    const pending = resolveHeaders({ provider: "cliproxyapi", endpoint: "https://host", apiKey: "old-key" }, {}, {});
    await expect(pending).rejects.toThrow(/无法解析/);
    await expect(pending).rejects.not.toThrow("SECRET");
  });
  it("preserves an existing authorization header case-insensitively", async () => {
    const headers = await resolveHeaders({ provider: "cliproxyapi", endpoint: "https://host", apiKey: "not-used", headers: { Authorization: "Custom test" } }, {}, {});
    expect(headers.get("authorization")).toBe("Custom test");
  });

});

describe("SSE", () => {
  it("parses comments, CRLF boundaries, multiline data and terminal partial frame", () => {
    const events: unknown[] = []; const parser = createSseParser((event) => events.push(event));
    for (const char of ': keepalive\r\nevent: test\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: [DONE]') parser.push(char);
    parser.end();
    expect(events).toEqual([{ event: "test", data: { a: 1 } }, { event: "message", data: "[DONE]" }]);
  });
  it("decodes UTF-8 across byte boundaries", async () => {
    const bytes = new TextEncoder().encode('data: {"text":"中文🌍"}\n\n');
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    const events: unknown[] = []; await consumeSseStream(stream, (event) => events.push(event.data));
    expect(events).toEqual([{ text: "中文🌍" }]);
  });
  it("aborts a stalled read and releases the lock", async () => {
    const controller = new AbortController(); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const pending = consumeSseStream(stream, () => {}, controller.signal);
    controller.abort(); await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalled(); expect(stream.locked).toBe(false);
  });
  it("limits bytes and cancels upstream on parser failure", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)); }, cancel });
    await expect(consumeSseStream(stream, () => {}, undefined, 5)).rejects.toThrow(/大小限制/);
    expect(cancel).toHaveBeenCalled();
    const cancel2 = vi.fn();
    const stream2 = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {}\n\n')); }, cancel: cancel2 });
    await expect(consumeSseStream(stream2, () => { throw new Error("handler"); })).rejects.toThrow("handler");
    expect(cancel2).toHaveBeenCalled();
  });
});
