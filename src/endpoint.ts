/** Normalize the companion provider's base URL, then append the Responses route. */
export function resolveResponsesEndpoint(baseUrl: string): string {
  let raw = baseUrl.trim();
  if (!raw) throw new Error("CLIProxyAPI baseUrl must not be empty.");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid CLIProxyAPI baseUrl."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("CLIProxyAPI baseUrl must be an HTTP(S) URL without credentials, query parameters or fragments.");
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
