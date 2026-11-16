import { Buffer } from "node:buffer";

export const MAX_SSE_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_SSE_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

export interface SseEvent { event: string; data: unknown }

/** Incremental SSE parser with UTF-8 byte limits, including split CRLF boundaries. */
export function createSseParser(onEvent: (event: SseEvent) => void | boolean) {
  let stopped = false;
  let buffer = "";
  let lineBytes = 0;
  let eventBytes = 0;
  let eventName = "";
  let dataLines: string[] = [];
  const dispatch = () => {
    if (dataLines.length) {
      const text = dataLines.join("\n");
      let data: unknown = text;
      try { data = JSON.parse(text); } catch { /* SSE also permits plain text. */ }
      if (onEvent({ event: eventName || "message", data }) === false) stopped = true;
    }
    eventName = "";
    dataLines = [];
    eventBytes = 0;
  };
  const line = (text: string) => {
    if (!text) { dispatch(); return; }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  };
  return {
    get stopped() { return stopped; },
    push(chunk: string) {
      let offset = 0;
      while (!stopped && offset < chunk.length) {
        const index = chunk.indexOf("\n", offset);
        const end = index < 0 ? chunk.length : index;
        const part = chunk.slice(offset, end);
        const bytes = Buffer.byteLength(part, "utf8");
        // Check before retaining partial lines; comments and unknown fields count too.
        if (lineBytes + bytes > MAX_SSE_LINE_BYTES) {
          throw new Error("CLIProxyAPI search SSE line exceeded the 4 MiB safety limit.");
        }
        const nextEventBytes = eventBytes + bytes + (index < 0 ? 0 : 1);
        if (nextEventBytes > MAX_SSE_EVENT_BYTES) {
          throw new Error("CLIProxyAPI search SSE event exceeded the 4 MiB safety limit.");
        }
        lineBytes += bytes;
        eventBytes = nextEventBytes;
        buffer += part;
        if (index < 0) return;
        const text = buffer.replace(/\r$/, "");
        buffer = "";
        lineBytes = 0;
        line(text);
        offset = index + 1;
      }
    },
    end() {
      if (stopped) return;
      if (buffer) line(buffer.replace(/\r$/, ""));
      buffer = "";
      lineBytes = 0;
      dispatch();
    },
  };
}

/** Bound raw response bytes before decoding and cancel on failure or protocol completion. */
export async function consumeSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void | boolean,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onEvent);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  let finished = false;
  let responseBytes = 0;
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        parser.push(decoder.decode());
        parser.end();
        finished = true;
        return;
      }
      if (value.byteLength > MAX_SSE_RESPONSE_BYTES - responseBytes) {
        throw new Error("CLIProxyAPI search SSE response exceeded the 32 MiB safety limit.");
      }
      responseBytes += value.byteLength;
      // Decode bounded slices even if the transport delivers one large chunk.
      for (let offset = 0; offset < value.byteLength; offset += 64 * 1024) {
        signal?.throwIfAborted();
        parser.push(decoder.decode(value.subarray(offset, offset + 64 * 1024), { stream: true }));
        if (parser.stopped) return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    // Cleanup failures must not replace the original parse, size-limit, or abort error.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
