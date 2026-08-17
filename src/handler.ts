import type { Browser } from "./browser.js"
import type { ToolResult } from "./codes.js"
import { isFormat, type Format } from "./extract.js"

/**
 * The one handler. Both `/fetch` and `/mcp` route into this, so the two
 * transports cannot drift apart — that is the entire reason there is one of it.
 * `/mcp` is a later slice; when it lands it calls this and nothing else.
 */

/** The four tools. A fifth needs a reason worth the attack surface. */
export const TOOLS = ["fetch_page", "fetch_pages", "check_reachable", "cache_lookup"] as const
export type ToolName = (typeof TOOLS)[number]

/**
 * A batch is a convenience, not a licence. Thirty pages is the design point, and
 * an unbounded list would be a way to queue an afternoon of work in one call.
 */
const MAX_BATCH = 50

/**
 * A problem with the request itself, not with the page. These are transport
 * errors and get an HTTP status — they deliberately do NOT get a member of the
 * closed code set, because that set describes what happened to a fetch.
 */
export class ToolError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message)
  }
}

interface FetchPageArgs {
  url: string
  format: Format
  waitFor?: string
  maxAge?: number
}

function parseFetchPageArgs(raw: unknown): FetchPageArgs {
  if (typeof raw !== "object" || raw === null) throw new ToolError(400, "arguments must be an object")
  const args = raw as Record<string, unknown>

  if (typeof args.url !== "string" || args.url === "") throw new ToolError(400, "arguments.url is required")

  const format = args.format ?? "markdown"
  if (!isFormat(format)) throw new ToolError(400, `format must be markdown, text, or html; got ${String(args.format)}`)

  if (args.wait_for !== undefined && typeof args.wait_for !== "string") {
    throw new ToolError(400, "wait_for must be a CSS selector string")
  }

  // `0` is meaningful — it forces a refresh — so this cannot use a falsy check.
  let maxAge: number | undefined
  if (args.max_age !== undefined) {
    if (typeof args.max_age !== "number" || !Number.isFinite(args.max_age) || args.max_age < 0) {
      throw new ToolError(400, "max_age must be a non-negative number of seconds; 0 forces a refresh")
    }
    maxAge = args.max_age
  }

  return { url: args.url, format, waitFor: args.wait_for as string | undefined, maxAge }
}

function requireObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) throw new ToolError(400, "arguments must be an object")
  return raw as Record<string, unknown>
}

function requireUrl(args: Record<string, unknown>): string {
  if (typeof args.url !== "string" || args.url === "") throw new ToolError(400, "arguments.url is required")
  return args.url
}

export async function callTool(browser: Browser, name: unknown, args: unknown): Promise<ToolResult> {
  if (typeof name !== "string") throw new ToolError(400, "tool is required")

  if (!(TOOLS as readonly string[]).includes(name)) {
    throw new ToolError(400, `unknown tool "${name}"; expected one of ${TOOLS.join(", ")}`)
  }

  switch (name as ToolName) {
    case "fetch_page":
      return browser.fetchPage(parseFetchPageArgs(args))

    case "fetch_pages": {
      const parsed = requireObject(args)
      const urls = parsed.urls
      if (!Array.isArray(urls) || urls.length === 0) {
        throw new ToolError(400, "arguments.urls must be a non-empty array")
      }
      if (urls.length > MAX_BATCH) {
        throw new ToolError(400, `arguments.urls has ${urls.length} entries; the maximum is ${MAX_BATCH}`)
      }
      // The shared options apply to every URL in the batch.
      return browser.fetchPages(urls.map((url) => parseFetchPageArgs({ ...parsed, url })))
    }

    case "check_reachable": {
      return browser.checkReachable(requireUrl(requireObject(args)))
    }

    case "cache_lookup": {
      const parsed = parseFetchPageArgs(args)
      return browser.cacheLookup(parsed.url, parsed.format, parsed.maxAge)
    }
  }
}
