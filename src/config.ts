import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { resolveResponsesEndpoint } from "./endpoint.js";

export const PLUGIN_ID = "cliproxyapi-websearch";
type HostConfig = OpenClawPluginApi["config"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && Boolean(v.trim()))?.trim();
}

export function getConfigDir(): string {
  return firstString(process.env.OPENCLAW_STATE_DIR, process.env.OPENCLAW_CONFIG_DIR) ?? join(homedir(), ".openclaw");
}

export function readJsonObject(path: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(data)) throw new Error("Invalid object");
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Do not reflect JSON snippets: provider files may contain credentials.
    throw new Error("Failed to read CLIProxyAPI config; check the file format and permissions.");
  }
}

export interface Connection {
  provider: string;
  endpoint: string;
  apiKey?: string;
  headers?: Record<string, unknown>;
}

/** Reuse the provider plugin's env/file contract without importing its private implementation. */
export function resolveConnection(cfg: HostConfig, configDir = getConfigDir()): Connection {
  const file = readJsonObject(join(configDir, "cliproxyapi.json"));
  const provider = firstString(process.env.CLIPROXYAPI_PROVIDER_ID, process.env.CPA_PROVIDER_ID, file.providerId) ?? "cliproxyapi";
  const providerConfig = cfg.models?.providers?.[provider];
  // Prefer the host's effective provider connection over discovery defaults.
  const baseUrl = firstString(
    providerConfig?.baseUrl,
    process.env.CLIPROXYAPI_BASE_URL, process.env.CPA_BASE_URL, file.baseUrl,
  ) ?? "http://127.0.0.1:8317";
  return {
    provider,
    endpoint: resolveResponsesEndpoint(baseUrl),
    apiKey: firstString(process.env.CLIPROXYAPI_API_KEY, process.env.CPA_API_KEY, file.apiKey),
    headers: providerConfig?.headers,
  };
}

export async function resolveHeaders(
  connection: ReturnType<typeof resolveConnection>,
  cfg: HostConfig,
  ctx: OpenClawPluginToolContext,
): Promise<Headers> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(connection.headers ?? {})) {
    if (typeof value !== "string" || /\$\{[^}]+\}/.test(value)) {
      throw new Error("Provider headers contain unresolved credentials; check the OpenClaw SecretRef configuration.");
    }
    headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  if (!headers.has("authorization")) {
    let apiKey: string | undefined;
    try {
      apiKey = await ctx.resolveApiKeyForProvider?.(connection.provider);
      if (!apiKey) {
        const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/agent-runtime");
        apiKey = (await resolveApiKeyForProvider({ provider: connection.provider, cfg, agentDir: ctx.agentDir, secretSentinels: false })).apiKey;
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "missing-provider-auth") {
        throw new Error("Failed to resolve CLIProxyAPI credentials; configure openclaw-cliproxyapi-provider first.");
      }
    }
    apiKey ||= connection.apiKey;
    if (!apiKey) throw new Error("Missing CLIProxyAPI API key; configure the provider first.");
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

