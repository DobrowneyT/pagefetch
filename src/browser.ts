import { chromium, errors as playwrightErrors, type BrowserContext, type Page, type Response } from "playwright"
import type { Config } from "./config.js"
import { result, type FetchResult } from "./codes.js"
import { extract, type Format } from "./extract.js"
import { validateUrl, validateUrlSyntax } from "./url-validation.js"

export interface FetchRequest {
  url: string
  format: Format
  waitFor?: string
}

const MAX_REDIRECTS = 10
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

  constructor(private readonly config: Config) {
    this.gate = new Semaphore(config.maxConcurrency)
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

    this.starting = chromium
      .launchPersistentContext(this.config.profileDir, {
        headless: true,
        // Chromium's default /dev/shm is 64MB inside Docker and it will crash on
        // a large page. compose.yml also sets shm_size; this is the belt.
        args: ["--disable-dev-shm-usage"],
      })
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
  }

  async fetchPage(request: FetchRequest): Promise<FetchResult> {
    // Validate before the browser is touched at all. An invalid URL should never
    // reach Chromium, because Chromium is the thing that would go and fetch it.
    const verdict = await validateUrl(request.url, this.config.allowHosts)
    if (!verdict.ok) return result("invalid_url", { detail: verdict.reason })

    return this.gate.run(() => this.navigate(request))
  }

  private async navigate(request: FetchRequest): Promise<FetchResult> {
    const context = await this.ensureContext()
    const page = await context.newPage()

    /** Hops rejected mid-flight. Non-empty means we stopped a redirect, not the origin. */
    const blockedHops: string[] = []
    /**
     * The end of the redirect chain. Tracked by hand because we fulfil the
     * navigation ourselves, so `page.url()` still reports what was submitted.
     */
    let finalUrl = request.url
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

    try {
      await page.route("**/*", async (route) => {
        const target = route.request().url()

        // Subresources: the cheap synchronous check. There are many of them and
        // they do not redirect the document anywhere.
        if (!route.request().isNavigationRequest()) {
          const hop = validateUrlSyntax(target, this.config.allowHosts)
          if (!hop.ok) {
            blockedHops.push(hop.reason)
            await route.abort("blockedbyclient").catch(() => {})
            return
          }
          await route.continue().catch(() => {})
          return
        }

        // Navigations: we walk the redirect chain ourselves.
        //
        // This is not fastidiousness. Chromium follows a 3xx INTERNALLY and
        // never re-enters Playwright's routing for the new URL, so a handler
        // that merely calls route.continue() validates the submitted URL and
        // nothing else — and the submitted URL is the one part of the chain an
        // attacker is happy to make look legitimate. Walking it here is what
        // makes "re-validated on every hop" true rather than aspirational.
        let current = target
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const verdict = await validateUrl(current, this.config.allowHosts)
          if (!verdict.ok) {
            blockedHops.push(verdict.reason)
            await route.abort("blockedbyclient").catch(() => {})
            return
          }

          let response
          try {
            response = await route.fetch({ url: current, maxRedirects: 0 })
          } catch (error) {
            blockedHops.push(`hop failed: ${(error as Error).message}`)
            await route.abort("failed").catch(() => {})
            return
          }

          const location = response.headers()["location"]
          const status = response.status()
          if (status >= 300 && status < 400 && location) {
            current = new URL(location, current).toString()
            continue
          }

          finalUrl = current
          await route.fulfill({ response }).catch(() => {})
          return
        }

        blockedHops.push(`more than ${MAX_REDIRECTS} redirects`)
        await route.abort("blockedbyclient").catch(() => {})
      })

      let response: Response | null
      try {
        response = await page.goto(request.url, {
          waitUntil: "domcontentloaded",
          timeout: this.config.navTimeoutMs,
        })
      } catch (error) {
        if (blockedHops.length > 0) {
          return result("invalid_url", { detail: `redirect hop rejected: ${blockedHops.join("; ")}` })
        }
        if (error instanceof playwrightErrors.TimeoutError) {
          return result("timeout", { detail: `navigation exceeded ${this.config.navTimeoutMs}ms` })
        }
        // A refused connection, a DNS failure, a TLS error. The closed set has no
        // member for "we could not reach it", and `timeout` is the only one whose
        // retry advice ("once") is right for this. Reported honestly in `detail`.
        return result("timeout", { detail: `navigation failed: ${(error as Error).message}` })
      }

      // A rejection can also land after goto resolves, when the abort happens on
      // a subresource or a client-side redirect.
      if (blockedHops.length > 0 && !response) {
        return result("invalid_url", { detail: `redirect hop rejected: ${blockedHops.join("; ")}` })
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
              url_final: this.resolveFinalUrl(page, request.url, finalUrl),
              detail: `selector ${request.waitFor} did not appear within ${this.config.selectorTimeoutMs}ms`,
            })
          }
          throw error
        }
      }

      const settled = lastMainResponse ?? response
      const status = settled?.status() ?? null
      const urlFinal = this.resolveFinalUrl(page, request.url, finalUrl)
      const html = await page.content()

      const blocked = this.classifyBlock(status, html, settled)
      if (blocked) return result(blocked.code, { status, url_final: urlFinal, detail: blocked.detail })

      return result("ok", {
        status,
        url_final: urlFinal,
        content: await extract(page, request.format),
      })
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
   * would have walked through — the PRD's whole premise is that a browser
   * resolves this as a side effect of being a browser, and it needs a few
   * seconds to do so.
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
   * `url_final` is worth getting exactly right — a caller checks it to notice a
   * redirect that landed somewhere unexpected, which is the whole point of
   * returning it. Three cases, and the browser's own URL is only right for one:
   *
   *   - The page navigated itself (a client-side redirect). The browser knows.
   *   - The origin redirected us. We fulfilled the navigation ourselves, so the
   *     browser still shows what was submitted and the chain end is the truth.
   *   - A fragment route. The fragment never went to the server, so it is not in
   *     the chain end, but it is the only part that identified the content.
   */
  private resolveFinalUrl(page: Page, requested: string, chainEnd: string): string {
    const withoutFragment = (raw: string): string => {
      try {
        const url = new URL(raw)
        url.hash = ""
        return url.toString()
      } catch {
        return raw
      }
    }

    const browserUrl = page.url()
    if (withoutFragment(browserUrl) !== withoutFragment(requested)) return browserUrl

    try {
      const end = new URL(chainEnd)
      const fragment = new URL(requested).hash
      if (fragment && !end.hash) end.hash = fragment
      return end.toString()
    } catch {
      return chainEnd
    }
  }

  /**
   * Maps what the origin said onto the closed code set.
   *
   * Note the gap: the set has no member for "the origin is broken" (a 500). The
   * consumer contract tells callers not to reach for pagefetch on a 500, so this
   * returns `ok` with the honest numeric status rather than inventing a code —
   * adding one is an API change and not this slice's to make.
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
