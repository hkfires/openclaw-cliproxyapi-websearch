export interface SseEvent { event: string; data: unknown }

/** Incremental SSE parser, including CRLF split across network chunks. */
export function createSseParser(onEvent: (event: SseEvent) => void | boolean) {
  let stopped = false;
  let buffer = "";
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
      if (stopped) return;
      buffer += chunk;
      let index: number;
      while (!stopped && (index = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, index).replace(/\r$/, ""));
        buffer = buffer.slice(index + 1);
      }
    },
    end() {
      if (stopped) return;
      if (buffer) line(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    },
  };
}

/** Cancel pending reads promptly, even on a stalled upstream. Response size is not limited. */
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
      parser.push(decoder.decode(value, { stream: true }));
      if (parser.stopped) return;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
