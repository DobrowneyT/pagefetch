/**
 * The validating egress proxy — layer 2, done properly.
 *
 * Every byte the browser sends to the network goes through here, and no
 * connection is opened to a host this module has not approved.
 *
 * ## Why this exists rather than route interception
 *
 * Chromium follows a 3xx INTERNALLY and never re-enters Playwright's routing, so
 * a route handler validates the submitted URL and nothing else — and the
 * submitted URL is the one part of a redirect chain an attacker is happy to make
 * look legitimate. The previous fix walked the chain by hand with
 * `route.fetch()`, which was correct but meant the top-level document no longer
 * travelled over the browser's own connection.
 *
 * A proxy gets both. Chromium issues `CONNECT host:443`, we validate the host,
 * and then we hand over a raw tunnel — **the browser performs its own TLS
 * handshake end to end**, so the connection is exactly what it would have been
 * without us. A redirect to another host produces a new `CONNECT`, so every hop
 * is still validated. A redirect within the same host stays inside a tunnel we
 * cannot see, which is fine: that host was already approved.
 *
 * ## The bonus: this closes the DNS rebinding window
 *
 * When a proxy is configured, Chromium does not resolve hostnames — it passes
 * the name to us. So we resolve it, check every answer, and then connect to
 * **that exact address**. There is no second lookup for a hostile resolver to
 * answer differently. `src/url-validation.ts` documents that gap as one this
 * design could not close; with the proxy in place, it is closed for real.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { connect as netConnect, isIP } from "node:net"
import { lookup } from "node:dns/promises"
import type { Duplex } from "node:stream"
import type { Config } from "./config.js"
import { isPrivateAddress, validateUrl } from "./url-validation.js"

/** Set on the proxy's own 403 so the browser layer can tell it from an origin's 403. */
export const REJECTED_HEADER = "x-pagefetch-rejected"

export interface Rejection {
  host: string
  reason: string
  at: number
}

type Target = { ok: true; address: string } | { ok: false; reason: string }

export class EgressProxy {
  private server: Server | null = null
  private port = 0
  private readonly log: Rejection[] = []

  constructor(private readonly config: Config) {}

  /** Rejections recorded at or after `since`. Used to explain a failed navigation. */
  rejectionsSince(since: number): Rejection[] {
    return this.log.filter((entry) => entry.at >= since)
  }

  get address(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async listen(): Promise<void> {
    if (this.server) return

    const server = createServer()
    server.on("request", (req, res) => void this.handleHttp(req, res))
    server.on("connect", (req, socket, head) => void this.handleConnect(req, socket, head))
    // A proxy that answered on anything but loopback would be an open proxy.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

    const listening = server.address()
    if (typeof listening === "object" && listening) this.port = listening.port
    this.server = server
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private record(host: string, reason: string): void {
    this.log.push({ host, reason, at: Date.now() })
    if (this.log.length > 200) this.log.shift()
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "egress_rejected", host, reason }))
  }

  /**
   * Approve a host and pin the address we will connect to.
   *
   * Resolution happens exactly once, here, and the caller connects to what this
   * returns — never to the name again.
   */
  private async resolveTarget(host: string, port: number): Promise<Target> {
    const allowed = this.config.allowHosts.has(host.toLowerCase())

    const verdict = await validateUrl(`http://${host}:${port}/`, this.config.allowHosts)
    if (!verdict.ok) return { ok: false, reason: verdict.reason }

    const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
    if (isIP(literal) !== 0) return { ok: true, address: literal }

    let answers: { address: string }[]
    try {
      answers = await lookup(host, { all: true })
    } catch {
      return { ok: false, reason: `${host} does not resolve` }
    }

    const chosen = answers[0]
    if (!chosen) return { ok: false, reason: `${host} resolves to nothing` }

    // The allowlist is how the fixture origin — necessarily on a private Docker
    // address — is reachable from the container suite. It is a config entry and
    // never a request parameter, so no caller can reach for it at call time.
    if (!allowed && isPrivateAddress(chosen.address)) {
      return { ok: false, reason: `${host} resolves to ${chosen.address}, a private or reserved address` }
    }

    return { ok: true, address: chosen.address }
  }

  /**
   * HTTPS. We approve the host and then get out of the way entirely — the bytes
   * that follow are the browser's own TLS, which is the whole point.
   */
  private async handleConnect(req: IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    const { host, port } = splitAuthority(req.url ?? "", 443)

    const target = await this.resolveTarget(host, port)
    if (!target.ok) {
      this.record(host, target.reason)
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\n${REJECTED_HEADER}: ${target.reason}\r\n\r\n`)
      return
    }

    const upstream = netConnect(port, target.address, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })

    upstream.on("error", () => clientSocket.destroy())
    clientSocket.on("error", () => upstream.destroy())
  }

  /** Plain HTTP. The request arrives in absolute form, so we see all of it. */
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? "")
    } catch {
      res.writeHead(400, { [REJECTED_HEADER]: "malformed proxy request" })
      res.end()
      return
    }

    const port = Number(url.port || 80)
    const target = await this.resolveTarget(url.hostname, port)
    if (!target.ok) {
      this.record(url.hostname, target.reason)
      // The browser renders this, so the status alone is ambiguous with an
      // origin's own 403. The header is what makes it unmistakably ours.
      res.writeHead(403, { [REJECTED_HEADER]: target.reason, "content-type": "text/plain" })
      res.end(`pagefetch refused this request: ${target.reason}`)
      return
    }

    const upstream = httpRequest(
      {
        host: target.address,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...req.headers, host: url.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )

    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  }
}

function splitAuthority(authority: string, fallbackPort: number): { host: string; port: number } {
  // IPv6 authorities are bracketed: [::1]:443
  const match = authority.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/)
  if (!match?.[1]) return { host: authority, port: fallbackPort }
  return { host: match[1], port: match[2] ? Number(match[2]) : fallbackPort }
}
