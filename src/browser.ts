import { chromium, errors as playwrightErrors, type BrowserContext, type Page, type Response } from "playwright"
import type { Config } from "./config.js"
import { result, type FetchResult } from "./codes.js"
import { EgressProxy, REJECTED_HEADER } from "./egress-proxy.js"
import { extract, render, type Format } from "./extract.js"
import { Robots } from "./robots.js"
import { Store } from "./store.js"
import { validateUrl } from "./url-validation.js"

export interface FetchRequest {
  url: string
  format: Format
  waitFor?: string
  /** Seconds. `0` forces a refresh. Omitted means the configured TTL. */
  maxAge?: number
}

const CHALLENGE_POLL_MS = 500

/** Markers a Cloudflare-style interstitial leaves behind even on a 200. */
const CHALLENGE_MARKERS = [
  "cf-browser-verification",
  "challenge-platform",
  "cf_chl_opt",
  "id=\"challenge-form\"",
  "just a moment",
  "checking your browser",
  "enable javascript and cookies to continue",
]

/**
 * Serialises fetches so the browser cannot starve the other containers on the
 * host. This is the global concurrency cap, not the per-domain rate limiter —
 * that is a separate concern and a separate slice.
 */
class Semaphore {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

export class Browser {
  private context: BrowserContext | null = null
  private starting: Promise<BrowserContext> | null = null
  private readonly gate: Semaphore
  private readonly proxy: EgressProxy
  private readonly robots: Robots
  private readonly store: Store

  constructor(private readonly config: Config) {
    this.gate = new Semaphore(config.maxConcurrency)
    this.proxy = new EgressProxy(config)
    this.store = new Store(config)
    // Robots fetches through the raw path, not through fetchPage, or checking
    // robots would require checking robots. It is also not page-cached — its
    // policy lives in its own table with its own TTL.
    this.robots = new Robots(config, this.store, (url) =>
      this.gate.run(() => this.navigate({ url, format: "text" }, false)),
    )
  }

  /**
   * A persistent profile matters more than any other single choice here. A cold
   * browser on every request looks far more robotic than one that has been to
   * the site before and kept its cookies — most "Cloudflare blocked me" cases
   * are a missing user agent, no cookie jar and no JavaScript, and a stock
   * browser with a profile fixes all three by being what it claims to be.
   *
   * No stealth plugins, no fingerprint patching, no UA string games. Stock.
   */
  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context
    if (this.starting) return this.starting

    this.starting = this.proxy
      .listen()
      .then(() =>
        chromium.launchPersistentContext(this.config.profileDir, {
          headless: true,
          args: [
            // Chromium's default /dev/shm is 64MB inside Docker and it will
            // crash on a large page. compose.yml also sets shm_size.
            "--disable-dev-shm-usage",
            // Everything egresses through our validating proxy.
            `--proxy-server=${this.proxy.address}`,
            // Chromium bypasses the proxy for loopback by default, which would
            // let a page reach 127.0.0.1 without ever being validated. This
            // subtracts that implicit exemption.
            "--proxy-bypass-list=<-loopback>",
          ],
        }),
      )
      .then((context) => {
        context.on("close", () => {
          this.context = null
          this.starting = null
        })
        this.context = context
        return context
      })
      .finally(() => {
        this.starting = null
      })

    return this.starting
  }

  async isAlive(): Promise<boolean> {
    return this.context !== null
  }

  async close(): Promise<void> {
    const context = this.context
    this.context = null
    if (context) await context.close().catch(() => {})
    await this.proxy.close()
    this.store.close()
  }

  async fetchPage(request: FetchRequest): Promise<FetchResult> {
    // Validate before the browser is touched at all. The proxy would refuse this
    // anyway; doing it here means an obviously bad URL costs nothing and gets a
    // better error than a failed navigation would produce.
    const verdict = await validateUrl(request.url, this.config.allowHosts)
    if (!verdict.ok) return result("invalid_url", { detail: verdict.reason })

    // The cache comes before everything, because a hit must cost nothing — no
    // network, and no robots round trip either. We only ever store pages we were
    // allowed to fetch in the first place.
    const maxAge = request.maxAge ?? this.config.cacheTtlSeconds
    const hit = this.store.lookupPage(request.url, maxAge)
    // `wait_for` means "this content is not complete until the selector exists".
    // That has to hold for a cached answer as well, or a caller who asked to
    // wait for award cards could be handed a stored page that never had any and
    // have no way to tell. Verified without touching the network.
    if (hit && (!request.waitFor || (await this.cachedContentSatisfies(hit.html, request.waitFor)))) {
      return result("ok", {
        status: hit.status,
        url_final: hit.urlFinal,
        fetched_at: hit.fetchedAt,
        from_cache: true,
        content: render({ html: hit.html, text: hit.text }, request.format),
      })
    }

    // Policy before network. A disallowed path must cost the origin nothing at
    // all beyond the robots.txt we already had to read.
    const permission = await this.robots.check(verdict.url)
    if (!permission.allowed) {
      return result(permission.code ?? "blocked_robots", { detail: permission.detail })
    }

    return this.gate.run(() => this.navigate(request, true))
  }

  private async navigate(request: FetchRequest, cacheable: boolean): Promise<FetchResult> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    const startedAt = Date.now()

    /**
     * The most recent main-frame document response.
     *
     * `page.goto()` returns the FIRST one, which is the wrong one as soon as an
     * interstitial navigates itself to the real page — we would hand back the
     * challenge's 403 next to the content it eventually served.
     */
    let lastMainResponse: Response | null = null
    page.on("response", (response) => {
      if (response.frame() === page.mainFrame() && response.request().resourceType() === "document") {
        lastMainResponse = response
      }
    })

    /**
     * Hosts this page actually asked for, so a refusal can be attributed to the
     * fetch that caused it. Without this, two overlapping fetches share the
     * proxy's rejection log by time alone, and a slow page timing out while
     * another fetch is refused elsewhere gets reported as `invalid_url` — the
     * wrong code, and a confusing one.
     */
    const requestedHosts = new Set<string>()
    page.on("request", (request) => {
      try {
        requestedHosts.add(new URL(request.url()).hostname.toLowerCase())
      } catch {
        // Not a URL we can attribute; the proxy would have refused it anyway.
      }
    })

    try {
      let response: Response | null
      try {
        response = await page.goto(request.url, {
          waitUntil: "domcontentloaded",
          timeout: this.config.navTimeoutMs,
        })
      } catch (error) {
        // An HTTPS hop the proxy refused fails the navigation outright, because
        // a rejected CONNECT is not a response the browser can render. Only
        // refusals of hosts THIS page asked for count — see requestedHosts.
        const refused = this.proxy
          .rejectionsSince(startedAt)
          .filter((rejection) => requestedHosts.has(rejection.host.toLowerCase()))
        if (refused.length > 0) {
          return result("invalid_url", { detail: `blocked at the hop: ${describe(refused)}` })
        }
        if (error instanceof playwrightErrors.TimeoutError) {
          return result("timeout", { detail: `navigation exceeded ${this.config.navTimeoutMs}ms` })
        }
        // A refused connection, a DNS failure, a TLS error. The closed set has no
        // member for "we could not reach it", and `timeout` is the only one whose
        // retry advice ("once") is right for this. Reported honestly in `detail`.
        return result("timeout", { detail: `navigation failed: ${(error as Error).message}` })
      }

      // A plain-HTTP hop the proxy refused comes back as a renderable 403, which
      // is indistinguishable from an origin's own 403 by status alone. The header
      // is what makes it unmistakably ours.
      const refusedInline = (lastMainResponse ?? response)?.headers()[REJECTED_HEADER]
      if (refusedInline) {
        return result("invalid_url", { detail: `blocked at the hop: ${refusedInline}` })
      }

      // Let an interstitial clear itself before we judge it, and before the
      // caller's wait_for runs — otherwise the selector is matched against the
      // challenge page rather than the content.
      await this.settleChallenge(page)

      if (request.waitFor) {
        try {
          await page.waitForSelector(request.waitFor, { timeout: this.config.selectorTimeoutMs })
        } catch (error) {
          if (error instanceof playwrightErrors.TimeoutError) {
            return result("timeout", {
              status: (lastMainResponse ?? response)?.status() ?? null,
              url_final: page.url(),
              detail: `selector ${request.waitFor} did not appear within ${this.config.selectorTimeoutMs}ms`,
            })
          }
          throw error
        }
      }

      const settled = lastMainResponse ?? response
      const status = settled?.status() ?? null
      const extracted = await extract(page)

      const blocked = this.classifyBlock(status, extracted.html, settled)
      if (blocked) return result(blocked.code, { status, url_final: page.url(), detail: blocked.detail })

      // The browser navigates redirects itself, so its own URL is the end of the
      // chain, fragment included.
      const urlFinal = page.url()
      const fetchedAt = new Date().toISOString()

      // Only successful fetches are cached. A challenge or a bench is a state of
      // the domain, not a property of the page, and #6 owns how long those last
      // — caching them here would quietly turn a one-hour bench into a 7-day one.
      if (cacheable) {
        this.store.storePage(request.url, {
          urlFinal,
          status,
          html: extracted.html,
          text: extracted.text,
          fetchedAt,
          fetchedAtMs: Date.now(),
        })
      }

      return result("ok", {
        status,
        url_final: urlFinal,
        fetched_at: fetchedAt,
        content: render(extracted, request.format),
      })
    } finally {
      await page.close().catch(() => {})
    }
  }

  /**
   * Does stored content satisfy the caller's `wait_for`?
   *
   * Parsed in the browser rather than by pattern-matching the HTML, because a
   * CSS selector deserves a CSS engine. Every request the page might make is
   * aborted first, so this stays a true cache hit — no network traffic at all,
   * which is the only definition of a hit this repo accepts.
   */
  private async cachedContentSatisfies(html: string, selector: string): Promise<boolean> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    try {
      await page.route("**/*", (route) => route.abort().catch(() => {}))
      await page.setContent(html, { waitUntil: "domcontentloaded" })
      return (await page.$(selector)) !== null
    } catch {
      // An unusable selector, or content we could not parse. We cannot vouch for
      // the hit, so we do not serve it.
      return false
    } finally {
      await page.close().catch(() => {})
    }
  }

  /** The interstitial's fingerprint, or null if this does not look like one. */
  private challengeMarker(html: string, response: Response | null): string | null {
    if (response?.headers()["cf-mitigated"]) return "cf-mitigated header"
    const haystack = html.slice(0, 20_000).toLowerCase()
    return CHALLENGE_MARKERS.find((marker) => haystack.includes(marker)) ?? null
  }

  /**
   * Wait for a challenge interstitial to clear itself, up to a bounded budget.
   *
   * **This is not challenge solving and must never become it.** Nothing here
   * misrepresents what the client is: no CAPTCHA service, no fingerprint
   * patching, no stealth plugin, no UA games. Those stay out of scope.
   *
   * The distinction is that a managed challenge is *designed* to be passed by
   * any real browser that executes its JavaScript and keeps a cookie jar. We
   * are a real browser that does both. Reporting `blocked_challenge` at t≈0,
   * as this did before, gave the wrong answer to a challenge a stock browser
   * would have walked through.
   *
   * If it has not cleared within the budget, the answer is still
   * `blocked_challenge`, and the answer is still stop.
   */
  private async settleChallenge(page: Page): Promise<void> {
    const stillChallenged = async (): Promise<boolean> => {
      try {
        return this.challengeMarker(await page.content(), null) !== null
      } catch {
        // "Execution context was destroyed" means the page is navigating, which
        // is exactly what a clearing challenge does. Treat it as in progress.
        return true
      }
    }

    if (!(await stillChallenged())) return

    const deadline = Date.now() + this.config.challengeBudgetMs
    while (Date.now() < deadline) {
      await page.waitForTimeout(CHALLENGE_POLL_MS)
      if (!(await stillChallenged())) return
    }
  }

  /**
   * Maps what the origin said onto the closed code set.
   *
   * Note the gap: the set has no member for "the origin is broken" (a 500). The
   * consumer contract tells callers not to reach for pagefetch on a 500, so this
   * returns `ok` with the honest numeric status rather than inventing a code.
   * Tracked in #4.
   */
  private classifyBlock(
    status: number | null,
    html: string,
    response: Response | null,
  ): { code: "blocked_challenge" | "not_found"; detail: string } | null {
    if (status === 404) return { code: "not_found", detail: "origin returned 404" }

    // By now settleChallenge has given any interstitial its budget to clear, so
    // a marker still being here means it did not.
    const marker = this.challengeMarker(html, response)
    if (marker) return { code: "blocked_challenge", detail: `interstitial did not clear (${marker})` }

    if (status === 403) return { code: "blocked_challenge", detail: "origin returned 403" }

    // An origin 429 is a refusal we cannot politely back off from until benching
    // exists, so it is reported as "stop" rather than "retry". Safe direction.
    if (status === 429) return { code: "blocked_challenge", detail: "origin returned 429" }

    return null
  }
}

function describe(rejections: { host: string; reason: string }[]): string {
  return rejections.map((entry) => entry.reason).join("; ")
}
