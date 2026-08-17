/**
 * The error contract.
 *
 * This is a CLOSED set. Adding a member is an API change: consumers make retry
 * decisions from these values, and a wrong code makes an agent either give up on
 * a reachable page or hammer a domain that refused it. If you are tempted to add
 * one, change `docs/USING-PAGEFETCH.md` first — that document is the promise.
 */
export const CODES = [
  "ok",
  "blocked_challenge",
  "blocked_robots",
  "rate_limited",
  "domain_benched",
  "not_found",
  "origin_error",
  "timeout",
  "invalid_url",
] as const

export type Code = (typeof CODES)[number]

/**
 * The response body for every tool, on both transports.
 *
 * Field order and naming are fixed by `docs/USING-PAGEFETCH.md` and by the
 * shipped consumer at `ai-scholarship-search/.agents/lib/src/fetch.ts`.
 */
export interface FetchResult {
  /** The closed-set code. This is what callers branch on. */
  code: Code
  /** The origin's HTTP status, or null when we never got one. */
  status: number | null
  /** The URL after all redirects. Distinct from the requested URL. */
  url_final: string | null
  fetched_at: string
  from_cache: boolean
  content: string | null
  /** Present only on `rate_limited`. Seconds. */
  retry_after?: number
  /**
   * Human-readable detail, for logs and for a human reading a failure.
   * Never branch on this — it is prose and it will change. Branch on `code`.
   */
  detail?: string
}

/** `fetch_pages`. Each entry carries its own code — one refusal does not sink the batch. */
export interface BatchResult {
  /** The batch itself succeeded. The per-URL verdicts are in `results`. */
  code: "ok"
  results: (FetchResult & { url: string })[]
}

/**
 * `check_reachable`. Everything here is answered from the store — no network.
 *
 * `code` is what `fetch_page` would return **right now**, as far as can be known
 * without asking the origin. That is what makes the probe worth calling: an
 * agent sees `domain_benched` and skips thirty rate-limited failures.
 */
export interface ReachableResult {
  code: Code
  url: string
  /** Whether a fetch would be served from cache, i.e. whether it is free. */
  from_cache: boolean
  /** When the cached copy was fetched, or null if there is none. */
  fetched_at: string | null
  domain: "available" | "benched" | "disabled"
  /** `unknown` when we have no cached policy — we will not fetch one to find out. */
  robots: "allowed" | "disallowed" | "unknown"
  detail?: string
}

export type ToolResult = FetchResult | BatchResult | ReachableResult

export function result(code: Code, fields: Partial<FetchResult> = {}): FetchResult {
  return {
    code,
    status: null,
    url_final: null,
    fetched_at: new Date().toISOString(),
    from_cache: false,
    content: null,
    ...fields,
  }
}
