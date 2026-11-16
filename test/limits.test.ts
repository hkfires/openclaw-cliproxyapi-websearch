import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SEARCH_TEXT_BYTES, executeWebSearch } from "../src/search.js";
import { MAX_SSE_EVENT_BYTES, MAX_SSE_LINE_BYTES, MAX_SSE_RESPONSE_BYTES, consumeSseStream, createSseParser } from "../src/sse.js";

const encoder = new TextEncoder();
const base = {
  query: "q", model: "test", provider: "cliproxyapi", endpoint: "https://cpa.test/v1/responses",
  headers: new Headers(), signal: new AbortController().signal,
};
const completed = { type: "response.completed" };
const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

// Keep streams open: exceeding a limit must cancel promptly, not wait for EOF.
function openStream(chunks: Uint8Array[]) {
  const cancel = vi.fn();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
    },
    cancel,
  });
  return { stream, cancel };
}

afterEach(() => vi.restoreAllMocks());

describe("SSE safety limits", () => {
  it.each([false, true])("rejects oversized unterminated lines before EOF (chunked=%s)", async (chunked) => {
    const bytes = encoder.encode("X".repeat(MAX_SSE_LINE_BYTES + 1));
    const chunks = chunked
      ? Array.from({ length: Math.ceil(bytes.length / 4096) }, (_, i) => bytes.subarray(i * 4096, (i + 1) * 4096))
      : [bytes];
    const { stream, cancel } = openStream(chunks);
    const onEvent = vi.fn();
    await expect(consumeSseStream(stream, onEvent)).rejects.toThrow("SSE line exceeded the 4 MiB safety limit");
    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("accepts a line exactly at the byte limit at EOF", () => {
    const parser = createSseParser(vi.fn());
    parser.push(`:${"X".repeat(MAX_SSE_LINE_BYTES - 1)}`);
    expect(() => parser.end()).not.toThrow();
  });

  it.each(["data: ", ":", "ignored: ", "event: "])("bounds multiline events including %s fields", async (prefix) => {
    const chunk = encoder.encode(`${prefix}${"X".repeat(16 * 1024)}\n`);
    const { stream, cancel } = openStream(Array.from({ length: Math.floor(MAX_SSE_EVENT_BYTES / chunk.byteLength) + 1 }, () => chunk));
    const onEvent = vi.fn();
    await expect(consumeSseStream(stream, onEvent)).rejects.toThrow("SSE event exceeded the 4 MiB safety limit");
    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("accepts an event exactly at the limit and resets the budget on a blank line", () => {
    const onEvent = vi.fn();
    const parser = createSseParser(onEvent);
    // Count framing bytes, including both LF delimiters.
    const event = `:${"X".repeat(MAX_SSE_EVENT_BYTES - 3)}\n\n`;
    parser.push(event);
    parser.push(event);
    parser.push('data: {"ok":true}\n\n');
    parser.end();
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ event: "message", data: { ok: true } });
  });

  it("counts UTF-8 bytes rather than JavaScript string length across network chunks", async () => {
    const bytes = encoder.encode(`:${"界".repeat(Math.floor(MAX_SSE_LINE_BYTES / 3) + 1)}`);
    const { stream, cancel } = openStream(Array.from({ length: Math.ceil(bytes.length / 4096) }, (_, i) => bytes.subarray(i * 4096, (i + 1) * 4096)));
    await expect(consumeSseStream(stream, vi.fn())).rejects.toThrow("SSE line exceeded");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("rejects an oversized raw chunk before decoding or invoking callbacks", async () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const { stream, cancel } = openStream([new Uint8Array(MAX_SSE_RESPONSE_BYTES + 1)]);
    const onEvent = vi.fn();
    await expect(consumeSseStream(stream, onEvent)).rejects.toThrow("SSE response exceeded the 32 MiB safety limit");
    expect(decode).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("accepts exactly 32 MiB across small frames but rejects the next raw byte", async () => {
    const chunk = encoder.encode(`:${"X".repeat(4093)}\n\n`);
    expect(chunk.byteLength).toBe(4096);
    const count = MAX_SSE_RESPONSE_BYTES / chunk.byteLength;
    let index = 0;
    const accepted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index++ < count) controller.enqueue(chunk);
        else controller.close();
      },
    });
    await consumeSseStream(accepted, vi.fn());
    expect(accepted.locked).toBe(false);
    const { stream, cancel } = openStream([...Array.from({ length: count }, () => chunk), encoder.encode(":")]);
    await expect(consumeSseStream(stream, vi.fn())).rejects.toThrow("SSE response exceeded");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});

describe("search result safety budget", () => {
  it.each(["delta", "done", "item"])("rejects a single oversized %s event before retaining its text", async (source) => {
    const text = "X".repeat(MAX_SEARCH_TEXT_BYTES + 1);
    const event = source === "item"
      ? { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text }] } }
      : source === "done"
        ? { type: "response.output_text.done", text }
        : { type: "response.output_text.delta", delta: text };
    const { stream, cancel } = openStream([frame(event)]);
    await expect(executeWebSearch({ ...base, fetchFn: async () => new Response(stream) })).rejects.toThrow("SSE line exceeded");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it.each(["delta", "done", "item", "mixed"])("rejects accumulated %s text without returning partial success", async (source) => {
    const text = "X".repeat(64 * 1024);
    const events: unknown[] = [];
    for (let i = 0; i < MAX_SEARCH_TEXT_BYTES / text.length + 1; i++) {
      const type = source === "mixed" ? (i % 2 === 0 ? "delta" : "item") : source;
      if (type === "delta") events.push({ type: "response.output_text.delta", delta: text });
      else if (type === "done" && i === 0) events.push({ type: "response.output_text.done", text });
      else events.push({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text }] } });
    }
    const { stream, cancel } = openStream([...events.map(frame), frame(completed)]);
    const pending = executeWebSearch({ ...base, fetchFn: async () => new Response(stream) });
    await expect(pending).rejects.toThrow("search result text exceeded the 8 MiB safety limit");
    await expect(pending).rejects.not.toThrow(text.slice(0, 100));
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("counts multibyte output using UTF-8 bytes", async () => {
    const delta = "界".repeat(16 * 1024);
    const count = Math.floor(MAX_SEARCH_TEXT_BYTES / encoder.encode(delta).length) + 1;
    const { stream, cancel } = openStream(Array.from({ length: count }, () => frame({ type: "response.output_text.delta", delta })));
    await expect(executeWebSearch({ ...base, fetchFn: async () => new Response(stream) })).rejects.toThrow("search result text exceeded");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("accepts a 2 MiB summary with repeated done, item and completed snapshots", async () => {
    const delta = "X".repeat(64 * 1024);
    const text = delta.repeat(32);
    const item = { type: "message", content: [{ type: "output_text", text }] };
    const { stream, cancel } = openStream([
      ...Array.from({ length: 32 }, () => frame({ type: "response.output_text.delta", delta })),
      frame({ type: "response.output_text.done", text }),
      frame({ type: "response.output_item.done", item }),
      frame({ type: "response.completed", response: { status: "completed", output: [item] } }),
    ]);
    const result = await executeWebSearch({ ...base, fetchFn: async () => new Response(stream) });
    expect(result.text).toBe(text);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("accepts exactly 8 MiB of streamed text without truncation", async () => {
    const delta = "X".repeat(64 * 1024);
    const { stream, cancel } = openStream([
      ...Array.from({ length: MAX_SEARCH_TEXT_BYTES / delta.length }, () => frame({ type: "response.output_text.delta", delta })),
      frame(completed),
    ]);
    const result = await executeWebSearch({ ...base, fetchFn: async () => new Response(stream) });
    expect(result.text).toBe("X".repeat(MAX_SEARCH_TEXT_BYTES));
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("includes appended source links in the text budget", async () => {
    const delta = "X".repeat(64 * 1024);
    const { stream, cancel } = openStream([
      ...Array.from({ length: MAX_SEARCH_TEXT_BYTES / delta.length }, () => frame({ type: "response.output_text.delta", delta })),
      frame({ type: "response.output_text.annotation.added", annotation: { url: "https://source.test/" } }),
      frame(completed),
    ]);
    await expect(executeWebSearch({ ...base, fetchFn: async () => new Response(stream) })).rejects.toThrow("search result text exceeded");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
