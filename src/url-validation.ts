/**
 * URL validation — layer 2 of three.
 *
 * This service fetches attacker-influenced URLs from inside a VPS that also runs
 * Postgres and several tenant APIs. That makes it an SSRF primitive by
 * construction, and a browser is worse than an HTTP client for it because it
 * follows redirects and executes whatever the page tells it to.
 *
 * Two things this module does NOT do, deliberately:
 *
 *   - It does not close the DNS-rebinding window. We resolve the hostname and
 *     check the answers, then Chromium resolves it again independently, and a
 *     hostile resolver can answer differently the second time. Nothing in a
 *     userspace check fixes that. Network isolation (layer 1) is what holds
 *     there, which is why it is layer 1.
 *   - It does not assume it is the only layer. Every rejection here is a
 *     defence in depth, not the defence.
 *
 * The check runs on the submitted URL AND on every redirect hop, because the
 * classic bypass is a public URL that 302s to 169.254.169.254. See
 * `src/browser.ts` for the hop-level enforcement and
 * `test/container/security.test.ts` for the test that proves it.
 */
import { isIP } from "node:net"
import { lookup } from "node:dns/promises"

export type Verdict = { ok: true; url: URL } | { ok: false; reason: string }

/** Suffixes that never name a public host. Checked against the whole hostname too. */
const PRIVATE_SUFFIXES = [".localhost", ".internal", ".local", ".home.arpa", ".lan", ".intranet"]
const PRIVATE_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"])

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".")
  if (parts.length !== 4) return true
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true

  const [a, b] = octets as [number, number, number, number]
  if (a === 0) return true // "this network"
  if (a === 10) return true // RFC1918
  if (a === 127) return true // loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local — the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

function isPrivateIpv6(raw: string): boolean {
  const addr = (raw.split("%")[0] ?? "").toLowerCase()
  if (addr === "" || addr === "::" || addr === "::1") return true

  // IPv4-mapped and IPv4-compatible forms carry a v4 address in the low bits;
  // judge them by that address, and refuse any embedded form we cannot read.
  const embedded = addr.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embedded?.[1]) return isPrivateIpv4(embedded[1])
  if (addr.startsWith("::")) return true

  const first = addr.split(":")[0]
  if (!first) return true
  const block = Number.parseInt(first, 16)
  if (!Number.isInteger(block)) return true
  if ((block & 0xfe00) === 0xfc00) return true // fc00::/7  unique local
  if ((block & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((block & 0xff00) === 0xff00) return true // ff00::/8  multicast
  return false
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isPrivateIpv4(ip)
  if (family === 6) return isPrivateIpv6(ip)
  return true // not an address we can reason about — refuse
}

/**
 * Synchronous checks: scheme, credentials, literal addresses, reserved names.
 *
 * Cheap enough to run on every subresource request the page makes, which is why
 * it is separate from the DNS-resolving check below.
 */
export function validateUrlSyntax(raw: string, allowHosts: ReadonlySet<string> = new Set()): Verdict {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `not a valid URL: ${raw}` }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol} is not allowed; only http and https` }
  }

  // Credentials in a URL are both an authenticated-scraping vector (out of
  // scope by design) and a parser-confusion trick — http://good.example@169.254.169.254/
  // reads as "good.example" to anything that splits on the wrong character.
  if (url.username || url.password) {
    return { ok: false, reason: "credentials in the URL are not allowed" }
  }

  const hostname = url.hostname.toLowerCase()
  if (!hostname) return { ok: false, reason: "URL has no host" }

  if (allowHosts.has(hostname)) return { ok: true, url }

  if (PRIVATE_NAMES.has(hostname)) return { ok: false, reason: `${hostname} is a reserved name` }
  if (PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, reason: `${hostname} is in a reserved namespace` }
  }

  // URL wraps IPv6 literals in brackets; isIP does not want them.
  const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  if (isIP(literal) !== 0) {
    if (isPrivateAddress(literal)) return { ok: false, reason: `${literal} is a private or reserved address` }
    return { ok: true, url }
  }

  // A hostname with no dot is never a public site. It is an intranet name or a
  // Docker service name — `http://postgres:5432/` is the shape of the attack
  // this service would otherwise be perfect for. Rejecting it here means we do
  // not have to survive a DNS lookup to be safe from it.
  if (!hostname.includes(".")) {
    return { ok: false, reason: `${hostname} is a single-label hostname, which cannot be a public site` }
  }

  return { ok: true, url }
}

/**
 * The full check: everything above, plus DNS resolution with every answer
 * inspected. A hostname that resolves to a private address is rejected even
 * though the URL text looks perfectly public — that is the common case, not an
 * exotic one.
 */
export async function validateUrl(raw: string, allowHosts: ReadonlySet<string> = new Set()): Promise<Verdict> {
  const syntax = validateUrlSyntax(raw, allowHosts)
  if (!syntax.ok) return syntax

  const hostname = syntax.url.hostname.toLowerCase()
  if (allowHosts.has(hostname)) return syntax

  const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  if (isIP(literal) !== 0) return syntax // already judged as a literal above

  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    return { ok: false, reason: `${hostname} does not resolve` }
  }

  if (addresses.length === 0) return { ok: false, reason: `${hostname} resolves to nothing` }

  // ANY private answer disqualifies the host. The browser resolves
  // independently and may pick a different answer than we did, so "one of them
  // is public" is not good enough.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return { ok: false, reason: `${hostname} resolves to ${address}, a private or reserved address` }
    }
  }

  return syntax
}
