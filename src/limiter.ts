/**
 * Politeness, enforced server-side.
 *
 * No caller can exceed these by accident or by insistence, which is the whole
 * reason they live here rather than in a client library.
 *
 * ## Why this matters more here than it looks
 *
 * The dashboard containers on this VPS NAT out through the host's address — the
 * same one the dashboard serves from. A ban earned by scraping does not land on
 * pagefetch. It lands on the dashboard and every tenant API behind it. A blocked
 * domain that keeps getting retried is precisely how an address gets listed.
 *
 * ## Spacing waits; the quota refuses
 *
 * Two different controls with two different answers:
 *
 *   - **≥ 5 s between requests** is enforced by *waiting*. Refusing here would
 *     make every second request in a batch fail, which is not what a rate is.
 *   - **20 requests/hour** is enforced by *refusing*, with `retry_after`. This
 *     is the cap that actually bounds what we do to a domain.
 *
 * A slot is reserved at the moment it is granted, not when the request
 * completes, so twenty-five simultaneous callers do not all pass the quota check
 * and then queue. The five that cannot have a slot are told immediately rather
 * than after waiting two minutes to be refused.
 */
import type { Code } from "./codes.js"
import type { Config } from "./config.js"
import type { Store } from "./store.js"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export type GateVerdict = { allowed: true } | { allowed: false; code: Code; detail: string }

export type SlotVerdict =
  | { allowed: true; waitMs: number }
  | { allowed: false; code: Code; detail: string; retryAfter: number }

export class Limiter {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  /**
   * Is this domain available at all?
   *
   * Checked before robots and before any network, because a benched domain
   * should not even have its robots.txt fetched.
   */
  gate(host: string): GateVerdict {
    const state = this.store.domainState(host)

    // Disabled shares `domain_benched` with benching, because the closed code
    // set has no separate member and the caller's answer is identical: stop and
    // report to the human. The distinction lives in `detail`, where it is a
    // human's problem rather than a branch.
    if (state.disabled) {
      return {
        allowed: false,
        code: "domain_benched",
        detail: `${host} is disabled after repeated blocks and needs a human to re-enable it`,
      }
    }

    if (state.benchedUntilMs > Date.now()) {
      const seconds = Math.ceil((state.benchedUntilMs - Date.now()) / 1000)
      return {
        allowed: false,
        code: "domain_benched",
        detail: `${host} is benched for another ${seconds}s after it blocked us`,
      }
    }

    return { allowed: true }
  }

  /** The domain's state, for `check_reachable` to report without touching it. */
  describe(host: string): "available" | "benched" | "disabled" {
    const state = this.store.domainState(host)
    if (state.disabled) return "disabled"
    return state.benchedUntilMs > Date.now() ? "benched" : "available"
  }

  /**
   * Reserve the right to make one request, and say how long to wait first.
   *
   * Reserving on grant is what makes the quota correct under concurrency.
   */
  acquire(host: string): SlotVerdict {
    const now = Date.now()
    this.store.prune(now - HOUR_MS, now - DAY_MS)

    const windowStart = now - HOUR_MS
    const used = this.store.countRequestsSince(host, windowStart)

    if (used >= this.config.maxRequestsPerDomainHour) {
      const oldest = this.store.oldestRequestSince(host, windowStart) ?? now
      const retryAfter = Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000))
      return {
        allowed: false,
        code: "rate_limited",
        detail: `${host} has used its ${this.config.maxRequestsPerDomainHour} requests for this hour`,
        retryAfter,
      }
    }

    const spacingMs = this.config.minDomainIntervalSeconds * 1000
    const earliest = this.store.lastScheduledMs(host) + spacingMs
    const scheduledAt = Math.max(now, earliest)

    this.store.recordRequestAt(host, scheduledAt)
    return { allowed: true, waitMs: scheduledAt - now }
  }

  /**
   * Record what the origin said. A 403 or a 429 is a refusal, and the response
   * to a refusal is to back off — not to try again more cleverly.
   */
  recordOutcome(host: string, status: number | null): void {
    if (status !== 403 && status !== 429) return

    const now = Date.now()
    this.store.recordBlock(host, now)
    this.store.setBench(host, now + this.config.benchMinutes * 60_000)

    const blocks = this.store.countBlocksSince(host, now - DAY_MS)
    console.log(
      JSON.stringify({ at: new Date().toISOString(), event: "domain_benched", host, status, blocks_today: blocks }),
    )

    if (blocks >= this.config.blocksBeforeDisable) {
      this.store.setDisabled(host, true)
      // Loud on purpose: a disabled domain is a state a human is expected to
      // notice and decide about, not something the service quietly manages.
      console.warn(
        `[pagefetch] DOMAIN DISABLED: ${host} blocked us ${blocks} times in a day. ` +
          `It will stay disabled until re-enabled by hand: ` +
          `docker compose exec pagefetch node dist/src/cli.js enable ${host}`,
      )
    }
  }
}
