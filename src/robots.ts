/**
 * `robots.txt` enforcement.
 *
 * This is policy, not a technical obstacle. A site that has said "do not crawl
 * this" has given an answer, and the correct response is to stop — so
 * `blocked_robots` must stay distinguishable from every failure code, and the
 * override must stay a config entry that no caller can reach at call time.
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
import type { Config } from "./config.js"
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
   */
  peek(target: URL): "allowed" | "disallowed" | "unknown" {
    if (this.config.robotsOverride.has(target.hostname.toLowerCase())) return "allowed"

    const cached = this.store.lookupRobots(target.origin, this.config.robotsTtlSeconds)
    if (!cached) return "unknown"
    if (cached.failure) return "unknown"

    return isAllowed(cached.rules ?? [], `${target.pathname}${target.search}`) ? "allowed" : "disallowed"
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
          detail: `could not read ${origin}/robots.txt — the origin served a challenge for it`,
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
