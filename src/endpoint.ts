/** Normalize the companion provider's base URL, then append the Responses route. */
export function resolveResponsesEndpoint(baseUrl: string): string {
  let raw = baseUrl.trim();
  if (!raw) throw new Error("CLIProxyAPI baseUrl 不能为空。");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("CLIProxyAPI baseUrl 无效。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("CLIProxyAPI baseUrl 必须是不含凭据、查询参数和片段的 HTTP(S) 地址。");
  }
  let path = url.pathname.replace(/\/+$/, "");
  // Match openclaw-cliproxyapi-provider: legacy backend URLs use the standard API.
  if (path.endsWith("/backend-api")) {
    path = `${path.slice(0, -"/backend-api".length).replace(/\/+$/, "")}/v1`;
  } else if (!path.endsWith("/v1")) {
    path += "/v1";
  }
  return `${url.origin}${path}/responses`;
}
