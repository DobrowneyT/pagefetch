/**
 * `POST /mcp` — JSON-RPC 2.0, MCP semantics, for agents connecting with
 * `claude mcp add`.
 *
 * **This file contains no behaviour.** It parses an envelope, calls
 * `callTool()`, and wraps the answer. Every decision about what a fetch does
 * lives in the handler both transports share, because the entire reason there is
 * one handler is that semantics must not depend on how a caller connected. If
 * logic starts accumulating here, that has gone wrong.
 *
 * ## What is and is not an error
 *
 * A code from the error contract is **not** a protocol error. A
 * `blocked_challenge` over MCP is the same `blocked_challenge` it is over
 * `/fetch` — a successful call that reports a refusal — and it comes back as a
 * normal result. Only malformed requests become JSON-RPC errors.
 *
 * Those errors carry the equivalent HTTP status in `data.httpStatus`, so the one
 * behavioural suite can assert the same thing on both transports rather than
 * growing a second set of expectations.
 */
import { callTool, ToolError, TOOLS } from "./handler.js"
import type { Browser } from "./browser.js"

const PROTOCOL_VERSION = "2025-06-18"

const JSON_RPC = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

const URL_PROPERTY = {
  type: "string",
  description: "Absolute http or https URL. Private and link-local addresses are rejected.",
} as const

const SHARED_FETCH_PROPERTIES = {
  format: {
    type: "string",
    enum: ["markdown", "text", "html", "raw"],
    description:
      "Shape of the returned content. Defaults to markdown. The first three are derived from the rendered page; \"raw\" is the response body exactly as the origin sent it, which is what you want for sitemaps, XML and JSON — anything the browser does not turn into a document.",
  },
  wait_for: {
    type: "string",
    description:
      "CSS selector to await before capture. Use it whenever you know what the content looks like — without it a slow client-side render may be captured half-finished. It applies to cached answers too.",
  },
  max_age: {
    type: "number",
    minimum: 0,
    description: "Seconds. Omit for the server TTL; 0 forces a refresh.",
  },
} as const

/**
 * Tool descriptions are the only documentation an agent reads before calling,
 * so the parts of the contract that stop it wasting time belong here.
 */
const TOOL_DEFINITIONS = [
  {
    name: "fetch_page",
    description:
      "Fetch one page with a real browser. Use it only AFTER a plain HTTP fetch has failed — for a client-side-rendered page, a fragment-route URL, or an origin that refuses non-browser clients. Returns a machine-readable `code`; most failure codes mean stop rather than retry.",
    inputSchema: {
      type: "object",
      properties: { url: URL_PROPERTY, ...SHARED_FETCH_PROPERTIES },
      required: ["url"],
    },
  },
  {
    name: "fetch_pages",
    description:
      "Fetch a list of pages, sequentially through the rate limiter rather than in parallel. Expect it to take real time. Each URL gets its own result and its own code, so one refusal does not sink the batch. Maximum 50 URLs.",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: URL_PROPERTY, minItems: 1, maxItems: 50 },
        ...SHARED_FETCH_PROPERTIES,
      },
      required: ["urls"],
    },
  },
  {
    name: "check_reachable",
    description:
      "Cheap probe: is this fetchable, is it already cached, is the domain benched. Makes no network request. CALL THIS FIRST before a batch — learning that a domain is benched costs one free call instead of thirty rate-limited failures. `robots: \"unknown\"` means the policy has not been read yet, not that there is none.",
    inputSchema: {
      type: "object",
      properties: { url: URL_PROPERTY },
      required: ["url"],
    },
  },
  {
    name: "cache_lookup",
    description:
      "Read-only cache query. No network, no rate limit, free — use it freely for re-reads of a page you already fetched. A miss returns code `ok` with `from_cache: false` and no content.",
    inputSchema: {
      type: "object",
      properties: { url: URL_PROPERTY, format: SHARED_FETCH_PROPERTIES.format, max_age: SHARED_FETCH_PROPERTIES.max_age },
      required: ["url"],
    },
  },
] as const

export interface McpReply {
  status: number
  /** null means "send nothing" — the correct answer to a JSON-RPC notification. */
  body: unknown | null
}

function success(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: "2.0", id, result } }
}

function failure(id: unknown, code: number, message: string, httpStatus: number): McpReply {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message, data: { httpStatus } } } }
}

export async function handleMcp(browser: Browser, payload: unknown): Promise<McpReply> {
  if (Array.isArray(payload)) {
    return failure(null, JSON_RPC.invalidRequest, "JSON-RPC batching is not supported", 400)
  }
  if (typeof payload !== "object" || payload === null) {
    return failure(null, JSON_RPC.invalidRequest, "request must be a JSON-RPC object", 400)
  }

  const { id, method, params } = payload as { id?: unknown; method?: unknown; params?: unknown }
  const isNotification = id === undefined

  if (typeof method !== "string") {
    return failure(id ?? null, JSON_RPC.invalidRequest, "method is required", 400)
  }

  // Notifications get no reply at all, by specification. `notifications/initialized`
  // is the one Claude Code sends after a successful handshake.
  if (isNotification) return { status: 202, body: null }

  switch (method) {
    case "initialize": {
      const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion
      return success(id, {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "pagefetch", version: "0.1.0" },
      })
    }

    case "ping":
      return success(id, {})

    case "tools/list":
      return success(id, { tools: TOOL_DEFINITIONS })

    case "tools/call": {
      const call = (params ?? {}) as { name?: unknown; arguments?: unknown }
      try {
        const outcome = await callTool(browser, call.name, call.arguments ?? {})
        // The result is JSON in a text block. `isError` stays unset: a code from
        // the error contract is a successful call reporting a refusal, not a
        // failed call.
        return success(id, {
          content: [{ type: "text", text: JSON.stringify(outcome) }],
          structuredContent: outcome,
        })
      } catch (error) {
        if (error instanceof ToolError) {
          const code = TOOLS.includes(call.name as never) ? JSON_RPC.invalidParams : JSON_RPC.methodNotFound
          return failure(id, code, error.message, error.httpStatus)
        }
        throw error
      }
    }

    default:
      return failure(id, JSON_RPC.methodNotFound, `unknown method "${method}"`, 404)
  }
}
