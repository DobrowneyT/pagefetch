import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import type { Browser } from "./browser.js"
import type { Config } from "./config.js"
import { callTool, ToolError } from "./handler.js"

const MAX_BODY_BYTES = 64 * 1024

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
  res.end(payload)
}

/** Constant-time, and length-safe: comparing unequal lengths would throw. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function authorised(req: IncomingMessage, config: Config): boolean {
  const header = req.headers.authorization
  if (!header?.startsWith("Bearer ")) return false
  return tokenMatches(header.slice("Bearer ".length), config.token)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new ToolError(413, "request body too large")
    chunks.push(chunk as Buffer)
  }
  if (size === 0) throw new ToolError(400, "request body is empty")
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new ToolError(400, "request body is not valid JSON")
  }
}

export function createPagefetchServer(config: Config, browser: Browser): Server {
  return createServer((req, res) => {
    void handle(req, res, config, browser).catch((error) => {
      console.error("[pagefetch] unhandled", error)
      if (!res.headersSent) send(res, 500, { error: "internal error" })
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, config: Config, browser: Browser): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname

  // Unauthenticated on purpose: it reveals nothing, it is loopback-only, and a
  // container healthcheck should not need the bearer token baked into compose.
  if (path === "/health" && req.method === "GET") {
    send(res, 200, { ok: true, browser: (await browser.isAlive()) ? "up" : "not started" })
    return
  }

  if (!authorised(req, config)) {
    send(res, 401, { error: "unauthorized" })
    return
  }

  if (path !== "/fetch" || req.method !== "POST") {
    send(res, 404, { error: `no route for ${req.method} ${path}` })
    return
  }

  try {
    const body = await readBody(req)
    if (typeof body !== "object" || body === null) throw new ToolError(400, "request body must be a JSON object")

    const { tool, arguments: args } = body as Record<string, unknown>
    const started = Date.now()
    const outcome = await callTool(browser, tool, args)

    // Structured, so patterns are visible without instrumenting the callers.
    console.log(
      JSON.stringify({
        at: outcome.fetched_at,
        tool,
        url: (args as Record<string, unknown>)?.url ?? null,
        code: outcome.code,
        status: outcome.status,
        ms: Date.now() - started,
        detail: outcome.detail ?? null,
      }),
    )

    send(res, 200, outcome)
  } catch (error) {
    if (error instanceof ToolError) {
      send(res, error.httpStatus, { error: error.message })
      return
    }
    throw error
  }
}
