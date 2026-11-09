import type { IncomingHttpHeaders } from "node:http";

/**
 * Same-origin rule for browser connections: the page that opens the socket
 * must be served from the host it connects to (Caddy keeps the Host header;
 * X-Forwarded-Host covers other proxies). Clients without an Origin header
 * (tools, tests) and loopback origins (the Vite dev server) are allowed.
 */
export function sameOrigin(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const allowed = [headers.host, headers["x-forwarded-host"]]
    .flat()
    .filter((h): h is string => typeof h === "string")
    .flatMap((h) => h.split(","))
    .map((h) => h.trim().toLowerCase());
  if (allowed.includes(host)) return true;
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}
