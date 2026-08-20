/**
 * `robots.txt` enforcement.
 *
 * This is policy, not a technical obstacle. A site that has said "do not crawl
 * this" has given an answer, and the correct response is to stop — so
 * `blocked_robots` must stay distinguishable from every failure code, and the
 * override must stay a config entry that no caller can reach at call time.
 *
 * There are two config entries, and both are deliberately coarse and host-level:
 * `PAGEFETCH_ROBOTS_OVERRIDE` fetches a host regardless of what it wrote, and
 * `PAGEFETCH_ROBOTS_DENY` refuses one regardless. Neither takes a path. Path
 * granularity is what robots.txt itself is for, and inventing a second dialect
 * of it in configuration is how you end up guessing at intent — see the note on
 * `isAllowed` for what that cost.
 *
 * ## Reading robots.txt requires the browser
 *
 * On the sites this service exists for, `robots.txt` is itself behind the
 * challenge — `scholarshipscanada.com` serves an interstitial for it. So we
 * fetch it the same way we fetch anything else, through the browser.
 *
 * ## Four outcomes, and only one of them is `blocked_robots`
 *
 * | robots.txt        | Decision                                            |
 * |-------------------|-----------------------------------------------------|
 * | 2xx with content  | Parse and apply. A disallowed path is `blocked_robots`. |
 * | 404 / no file     | **Allowed.** RFC 9309: absent means no restrictions. |
 * | Challenge         | Refuse, reported as `blocked_challenge` — we could not learn the policy, and the site is refusing us anyway. |
 * | Unreachable / 5xx | Refuse. RFC 9309 says an unreachable robots.txt means assume disallow. |
 *
 * The distinction that matters: a genuine 404 is a site with no restrictions,
 * and reading it as "unreadable, therefore refuse" would wrongly lock us out of
 * every site that simply has no robots file. A challenge is not a 404, and
 * reading *that* as "no restrictions" would conveniently always resolve in our
 * favour, which is why it does not.
 */
import type { Code, FetchResult } from "./codes.js"
import { challengeAdvice, type Config } from "./config.js"
import type { CachedRobots, Store } from "./store.js"

export interface Rule {
  allow: boolean
  pattern: string
}

export interface RobotsVerdict {
  allowed: boolean
  /** Set when not allowed. `blocked_robots` only ever means "we read it and it says no". */
  code?: Code
  detail?: string
}

/**
 * What is known about a policy without asking the origin.
 *
 * `unknown` is three different situations wearing one word — never read, read
 * and lapsed, read and unreadable — and they are not equally informative. "We
 * read this yesterday and it said `Disallow: /`" is very nearly an answer; "we
 * have never asked" is not. The probe collapsed all three to `unknown` beside a
 * `code: "ok"`, and an agent told to branch on `code` walked into a certain
 * refusal. So `detail` now carries the difference, in words, every time.
 */
export interface RobotsPeek {
  /** What is known about the policy itself. */
  state: "allowed" | "disallowed" | "unknown"
  /**
   * The code a fetch would refuse with on account of robots, if it would refuse.
   * Absent means no *known* obstacle — which is not the same as "this will work".
   */
  code?: Code
  /** One sentence for the caller. Always set when the state is not plainly allowed. */
  detail?: string
}

/**
 * Parse the groups that apply to us.
 *
 * We are a stock browser and do not identify as a named crawler — no UA games,
 * per the design — so the groups that apply are the `*` ones.
 */
export function parseRobots(text: string): Rule[] {
  const rules: Rule[] = []
  let agents: string[] = []
  let collectingAgents = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? ""
    if (!line) continue

    const separator = line.indexOf(":")
    if (separator === -1) continue

    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()

    if (key === "user-agent") {
      // Consecutive user-agent lines share one group of rules.
      if (!collectingAgents) {
        agents = []
        collectingAgents = true
      }
      agents.push(value.toLowerCase())
      continue
    }

    collectingAgents = false
    if (key !== "allow" && key !== "disallow") continue
    if (!agents.includes("*")) continue
    // An empty `Disallow:` means "nothing is disallowed", which is the same as
    // having no rule at all.
    if (!value) continue

    rules.push({ allow: key === "allow", pattern: value })
  }

  return rules
}

function matchesPattern(pattern: string, path: string): boolean {
  let source = ""
  let anchorEnd = false

  for (let i = 0; i < pattern.length; i += 1) {
    const character = pattern[i] as string
    if (character === "*") {
      source += ".*"
    } else if (character === "$" && i === pattern.length - 1) {
      anchorEnd = true
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }

  return new RegExp(`^${source}${anchorEnd ? "$" : ""}`).test(path)
}

/**
 * RFC 9309: the most specific match wins, measured in octets, and an `Allow`
 * beats a `Disallow` of equal length.
 *
 * ## The trailing slash, and why this follows the standard exactly
 *
 * `Disallow: /search-jobs/` does not match `/search-jobs`. This briefly did not
 * hold — a pattern ending in `/` was made to match the bare path too, on the
 * theory that a site writing the slash means the directory and its own page.
 *
 * `careers.arm.com` is the counter-example that settles it. Its entire
 * robots.txt is one rule, `Disallow:/search-jobs/`, and the paths beneath it are
 * that platform's AJAX endpoints — `/search-jobs/results`,
 * `/search-jobs/resultspost`. The site leaves every `/job/<slug>/…` detail page
 * allowed, so reading it as "job search is closed to crawlers" is incoherent:
 * you cannot block the index while publishing every entry. And a site that
 * wanted the whole area blocked would write `Disallow: /search-jobs`, which is
 * both shorter and what actually does it.
 *
 * So the slash is precise rather than sloppy, and guessing otherwise
 * over-blocked a page the site permits — the exact failure the error contract
 * exists to prevent. When a host genuinely needs refusing beyond what it wrote,
 * that is a config decision a person makes: `PAGEFETCH_ROBOTS_DENY`.
 */
export function isAllowed(rules: readonly Rule[], path: string): boolean {
  let best: { allow: boolean; length: number } | null = null

  for (const rule of rules) {
    if (!matchesPattern(rule.pattern, path)) continue
    const length = rule.pattern.length
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length }
    }
  }

  return best ? best.allow : true
}

/** Refused by local policy, said the same way wherever it is said. */
function denyDetail(host: string): string {
  return `${host} is in PAGEFETCH_ROBOTS_DENY — refused by local policy, not by its robots.txt`
}

/**
 * How long ago, at a granularity a person can act on.
 *
 * "27.8 hours ago" is the sentence that would have made the LinkedIn probe
 * obviously wrong at a glance; "1761 minutes" would not have.
 */
function ago(ms: number): string {
  const minutes = ms / 60_000
  if (minutes < 90) return `${Math.round(minutes)} minutes ago`
  const hours = minutes / 60
  if (hours < 48) return `${hours.toFixed(1)} hours ago`
  return `${(hours / 24).toFixed(1)} days ago`
}

export class Robots {
  /**
   * Policy fetches in flight, keyed by origin.
   *
   * Without this, twenty simultaneous first-requests to a domain each find no
   * cached policy and each fetch robots.txt — twenty requests to prove we are
   * allowed to make one. The store deduplicates across time; this deduplicates
   * across concurrency.
   */
  private readonly inflight = new Map<string, Promise<CachedRobots>>()

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    /** Fetches a URL without consulting robots — otherwise this would recurse. */
    private readonly fetchRaw: (url: string) => Promise<FetchResult>,
  ) {}

  async check(target: URL): Promise<RobotsVerdict> {
    const host = target.hostname.toLowerCase()

    // Checked before the override, so a host named in both is refused rather
    // than fetched. Two contradictory config entries are a mistake, and the
    // safe reading of a mistake is the one that does not touch the origin.
    if (this.config.robotsDeny.has(host)) {
      return {
        allowed: false,
        code: "blocked_robots",
        detail: denyDetail(host),
      }
    }

    // The override is a config entry and never a request parameter, so no caller
    // can relax policy at call time. It is logged every time it is used, because
    // it is a deliberate decision to ignore what a site asked for.
    if (this.config.robotsOverride.has(host)) {
      console.log(JSON.stringify({ at: new Date().toISOString(), event: "robots_override_used", host }))
      return { allowed: true }
    }

    const entry = await this.policyFor(target)

    if (entry.failure) {
      return { allowed: false, code: entry.failure.code, detail: entry.failure.detail }
    }

    const path = `${target.pathname}${target.search}`
    if (isAllowed(entry.rules ?? [], path)) return { allowed: true }

    return {
      allowed: false,
      code: "blocked_robots",
      detail: `robots.txt for ${target.origin} disallows ${path}`,
    }
  }

  /**
   * What we already know, without fetching anything.
   *
   * `check_reachable` and `cache_lookup` promise zero outbound requests, so they
   * cannot go and read a policy they do not have. An unknown answer is an honest
   * one; pretending would be worse than admitting it.
   *
   * But admitting it is not the same as saying nothing. Where the store knows
   * *why* the policy is unknown — never asked, lapsed, or unreadable — and what
   * it last said, that goes in `detail`, because a caller who is about to spend
   * thirty fetches deserves the strongest hint we can give away for free.
   */
  peek(target: URL): RobotsPeek {
    const host = target.hostname.toLowerCase()
    const origin = target.origin
    const path = `${target.pathname}${target.search}`

    // Both config entries are decisions a person already made, so neither is
    // ever stale and neither depends on the store.
    if (this.config.robotsDeny.has(host)) {
      return {
        state: "disallowed",
        code: "blocked_robots",
        detail: denyDetail(host),
      }
    }
    if (this.config.robotsOverride.has(host)) {
      return { state: "allowed", detail: `${host} is in PAGEFETCH_ROBOTS_OVERRIDE — its robots.txt is deliberately ignored` }
    }

    const stored = this.store.peekRobots(origin)
    if (!stored) {
      return {
        state: "unknown",
        detail: `no robots.txt has been read for ${origin} yet — fetch_page will read it first, and may refuse once it has`,
      }
    }

    const age = Date.now() - stored.fetchedAtMs
    const fresh = age <= this.config.robotsTtlSeconds * 1000

    // A cached failure is not "no policy known, proceed hopefully" — within the
    // TTL it is precisely what a fetch would refuse with, so say so.
    if (stored.failure) {
      return fresh
        ? { state: "unknown", code: stored.failure.code, detail: stored.failure.detail }
        : {
            state: "unknown",
            detail: `robots.txt for ${origin} could not be read ${ago(age)} (${stored.failure.code}); fetch_page will try again`,
          }
    }

    const verdict = isAllowed(stored.rules ?? [], path) ? "allowed" : "disallowed"
    if (fresh) {
      return verdict === "allowed"
        ? { state: "allowed" }
        : { state: "disallowed", code: "blocked_robots", detail: `robots.txt for ${origin} disallows ${path}` }
    }

    // Lapsed. It may not decide the fetch — RFC 9309 caps the cache at a day —
    // but it is much better than nothing as a prediction, so it is reported as
    // one: `unknown`, no code, and a sentence saying what it last said.
    return {
      state: "unknown",
      detail:
        verdict === "allowed"
          ? `the cached robots.txt for ${origin} lapsed — read ${ago(age)}, when it allowed ${path}. fetch_page will re-read it.`
          : `the cached robots.txt for ${origin} lapsed — read ${ago(age)}, when it DISALLOWED ${path}. ` +
            `fetch_page will re-read it and will almost certainly return blocked_robots.`,
    }
  }

  private async policyFor(target: URL): Promise<CachedRobots> {
    const origin = target.origin
    const cached = this.store.lookupRobots(origin, this.config.robotsTtlSeconds)
    if (cached) return cached

    const existing = this.inflight.get(origin)
    if (existing) return existing

    const pending = this.fetchPolicy(origin)
      .then((entry) => {
        this.store.storeRobots(origin, entry)
        return entry
      })
      .finally(() => this.inflight.delete(origin))

    this.inflight.set(origin, pending)
    return pending
  }

  private async fetchPolicy(origin: string): Promise<CachedRobots> {
    const outcome = await this.fetchRaw(`${origin}/robots.txt`)
    const fetchedAtMs = Date.now()

    // No robots file. RFC 9309: absent means no restrictions apply.
    if (outcome.code === "not_found") return { fetchedAtMs, rules: [] }

    if (outcome.code === "ok") {
      // A 2xx that is not actually a robots file (an HTML 404 page served with
      // status 200, say) parses to no rules, which is the same as no file.
      return { fetchedAtMs, rules: parseRobots(outcome.content ?? "") }
    }

    if (outcome.code === "blocked_challenge") {
      return {
        fetchedAtMs,
        rules: null,
        failure: {
          code: "blocked_challenge",
          detail:
            `could not read ${origin}/robots.txt — the origin served a challenge for it — ` +
            challengeAdvice(this.config),
        },
      }
    }

    return {
      fetchedAtMs,
      rules: null,
      failure: {
        code: outcome.code,
        detail: `could not read ${origin}/robots.txt (${outcome.code}: ${outcome.detail ?? "no detail"})`,
      },
    }
  }
}
