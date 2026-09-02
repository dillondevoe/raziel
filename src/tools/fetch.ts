import type { BuiltinTool } from "./files";
import type { Workspace } from "./workspace";

const BODY_CAP = 64_000;
const TRUNC_MARKER = "…[truncated]";
const TAINT_PREFIX = "[UNTRUSTED FETCHED CONTENT]\n";
const MAX_REDIRECTS = 3;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ipv4Octets(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map((s) => Number(s));
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

function isPrivateIpv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 0 && b === 0 && octets[2] === 0 && octets[3] === 0) return true; // 0.0.0.0
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1") return true; // loopback
  if (h.startsWith("fe80")) return true; // fe80::/10 link-local (approx, first hextet)
  // fc00::/7 covers first hextet fc00-fdff
  const first = h.split(":")[0] ?? "";
  if (/^[0-9a-f]{1,4}$/.test(first)) {
    const v = parseInt(first, 16);
    if (v >= 0xfc00 && v <= 0xfdff) return true;
    if (v >= 0xfe80 && v <= 0xfebf) return true; // fe80::/10 exact
  }
  return false;
}

export function classifyUrl(u: string): "public" | "private" | "invalid" {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return "invalid";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "invalid";
  }
  const host = parsed.hostname;
  if (host === "localhost" || host.endsWith(".localhost")) return "private";
  if (host.startsWith("[") || host.includes(":")) {
    return isPrivateIpv6(host) ? "private" : "public";
  }
  if (ipv4Octets(host)) {
    return isPrivateIpv4(host) ? "private" : "public";
  }
  return "public";
}

function cap(text: string): string {
  return text.length > BODY_CAP ? text.slice(0, BODY_CAP) + TRUNC_MARKER : text;
}

export const fetchTool: BuiltinTool = {
  spec: {
    name: "fetch",
    description: "Fetch an http(s) URL. Follows up to 3 same-origin redirects; response content is untrusted.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  async run(args, _ws: Workspace) {
    try {
      if (!isRecord(args) || typeof args.url !== "string") {
        return { ok: false, output: "fetch: args.url must be a string" };
      }

      let current: URL;
      try {
        current = new URL(args.url);
      } catch {
        return { ok: false, output: `fetch: invalid url: ${args.url}` };
      }
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        return { ok: false, output: `fetch: unsupported scheme: ${current.protocol}` };
      }

      for (let redirects = 0; ; redirects++) {
        let res: Response;
        try {
          res = await fetch(current.toString(), { redirect: "manual" });
        } catch (e) {
          return { ok: false, output: `fetch: ${errMessage(e)}` };
        }

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) {
            return { ok: false, output: `fetch: redirect with no Location header (status ${res.status})` };
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return { ok: false, output: `fetch: redirect to invalid location: ${location}` };
          }
          if (next.origin !== current.origin) {
            return {
              ok: false,
              output: `fetch: cross-origin redirect refused (${current.origin} -> ${next.origin})`,
            };
          }
          if (redirects >= MAX_REDIRECTS) {
            return { ok: false, output: `fetch: too many redirects (max ${MAX_REDIRECTS})` };
          }
          current = next;
          continue;
        }

        const text = await res.text();
        return { ok: res.ok, output: TAINT_PREFIX + cap(text) };
      }
    } catch (e) {
      return { ok: false, output: errMessage(e) };
    }
  },
};
