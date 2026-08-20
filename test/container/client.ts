import type { FetchResult } from "../../src/codes.js"

const BASE = process.env.PAGEFETCH_URL ?? "http://127.0.0.1:8790"
const TOKEN = process.env.PAGEFETCH_TOKEN ?? ""

/**
 * Which surface the suite is exercising.
 *
 * The whole point of one handler is that semantics do not diverge, so the same
 * behavioural tests run against both `/fetch` and `/mcp` — set
 * `PAGEFETCH_TRANSPORT=mcp` and nothing else changes. If a test needs to know
 * which transport it is on, that is a smell worth chasing rather than
 * accommodating.
 */
export const transport = process.env.PAGEFETCH_TRANSPORT === "mcp" ? "mcp" : "fetch"

/**
 * Appended to URLs in tests that need a cold cache.
 *
 * The suite runs twice against one service, so without this the second
 * transport inherits the first one's cache entries and every "the first fetch
 * cannot be a hit" assertion fails for a reason that has nothing to do with the
 * transport.
 */
export const tag = transport

export interface RawResponse {
  /**
   * For `/mcp`, the HTTP status the same request would have produced on
   * `/fetch`. JSON-RPC errors carry it in `data.httpStatus` precisely so the
   * suite can assert one thing rather than two.
   */
  httpStatus: number
  body: Record<string, unknown>
}

async function post(path: string, payload: unknown, token: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  })
}

let nextId = 1

/**
 * Tests talk to the running service over HTTP and assert on the response body
 * and code. Nothing here reaches inside the browser wrapper — a test that
 * survives swapping Playwright out, and fails if the error contract changes, is
 * the right test.
 */
export async function call(tool: string, args: unknown, token: string = TOKEN): Promise<RawResponse> {
  if (transport === "fetch") {
    const response = await post("/fetch", { tool, arguments: args }, token)
    return { httpStatus: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  const response = await post(
    "/mcp",
    { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: tool, arguments: args } },
    token,
  )

  // Auth and transport failures never reach JSON-RPC.
  if (!response.ok) {
    return { httpStatus: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> }
  }

  const envelope = (await response.json()) as {
    result?: { content?: { text?: string }[]; structuredContent?: Record<string, unknown> }
    error?: { message?: string; data?: { httpStatus?: number } }
  }

  if (envelope.error) {
    return {
      httpStatus: envelope.error.data?.httpStatus ?? 500,
      body: { error: envelope.error.message ?? "unknown error" },
    }
  }

  // Unwrap result.content[] the way a real MCP consumer would, rather than
  // reading structuredContent — that keeps the text block honest.
  const text = envelope.result?.content?.[0]?.text
  if (typeof text !== "string") {
    return { httpStatus: 500, body: { error: "MCP result carried no text content" } }
  }
  return { httpStatus: 200, body: JSON.parse(text) as Record<string, unknown> }
}

export async function fetchPage(args: unknown): Promise<FetchResult> {
  const { body } = await call("fetch_page", args)
  return body as unknown as FetchResult
}

/** Raw JSON-RPC, for the protocol-level tests that are inherently MCP-only. */
export async function rpc(method: string, params?: unknown, token: string = TOKEN): Promise<Response> {
  return post("/mcp", { jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }, token)
}

export async function rpcNotify(method: string, token: string = TOKEN): Promise<Response> {
  return post("/mcp", { jsonrpc: "2.0", method }, token)
}

export const baseUrl = BASE
