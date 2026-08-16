import type { Browser } from "./browser.js"
import type { FetchResult } from "./codes.js"
import { isFormat, type Format } from "./extract.js"

/**
 * The one handler. Both `/fetch` and `/mcp` route into this, so the two
 * transports cannot drift apart — that is the entire reason there is one of it.
 * `/mcp` is a later slice; when it lands it calls this and nothing else.
 */

/** The four tools. A fifth needs a reason worth the attack surface. */
export const TOOLS = ["fetch_page", "fetch_pages", "check_reachable", "cache_lookup"] as const
export type ToolName = (typeof TOOLS)[number]

const IMPLEMENTED: ReadonlySet<string> = new Set<ToolName>(["fetch_page"])

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

  // max_age is accepted and ignored until the cache exists. Rejecting it would
  // break the shipped consumer, which already sends it.
  return { url: args.url, format, waitFor: args.wait_for as string | undefined }
}

export async function callTool(browser: Browser, name: unknown, args: unknown): Promise<FetchResult> {
  if (typeof name !== "string") throw new ToolError(400, "tool is required")

  if (!(TOOLS as readonly string[]).includes(name)) {
    throw new ToolError(400, `unknown tool "${name}"; expected one of ${TOOLS.join(", ")}`)
  }
  if (!IMPLEMENTED.has(name)) {
    throw new ToolError(501, `${name} is specified but not built yet; only fetch_page exists in this slice`)
  }

  return browser.fetchPage(parseFetchPageArgs(args))
}
