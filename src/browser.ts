import { mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  chromium,
  errors as playwrightErrors,
  type Browser as PlaywrightBrowser,
  type BrowserContext,
  type Download,
  type Page,
  type Response,
} from "playwright"
import { challengeAdvice, fetchMode, type Config } from "./config.js"
import { browserTreeRssBytes, stateFileName } from "./lifecycle.js"
import { result, type BatchResult, type FetchResult, type ReachableResult } from "./codes.js"
import { EgressProxy, REJECTED_HEADER } from "./egress-proxy.js"
import { extract, render, satisfies, type Format } from "./extract.js"
import { Limiter } from "./limiter.js"
import { Robots } from "./robots.js"
import { Store } from "./store.js"
import { validateUrl, validateUrlSyntax } from "./url-validation.js"

export interface FetchRequest {
  url: string
  format: Format
  waitFor?: string
  /** Seconds. `0` forces a refresh. Omitted means the configured TTL. */
  maxAge?: number
}

const CHALLENGE_POLL_MS = 500

/**
 * The ceiling on a `raw` body. Generous enough for a large sitemap — the one on
 * `scholarshipscanada.com` is 6.8MB — and low enough that an unbounded download
 * cannot exhaust the process.
 */
const MAX_RAW_BYTES = 32 * 1024 * 1024

/** How long to wait for the download event that follows a download-aborted navigation. */
const DOWNLOAD_EVENT_TIMEOUT_MS = 5_000

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

  /** Resolves once nothing is in flight — how a restart drains rather than truncates. */
  async idle(): Promise<void> {
    while (this.active > 0) await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export class Browser {
  private browser: PlaywrightBrowser | null = null
  private starting: Promise<PlaywrightBrowser> | null = null
  /** One context per domain, most-recently-used last. Insertion order is the LRU. */
  private readonly contexts = new Map<string, BrowserContext>()
  private restarting: Promise<void> | null = null
  private restarts = 0
  private lastRestartAt: string | null = null
  private readonly startedAt = Date.now()
  private readonly gate: Semaphore
  private readonly proxy: EgressProxy
  private readonly robots: Robots
  private readonly store: Store
  private readonly limiter: Limiter

  constructor(private readonly config: Config) {
    this.gate = new Semaphore(config.maxConcurrency)
    this.proxy = new EgressProxy(config)
    this.store = new Store(config)
    this.limiter = new Limiter(config, this.store)
    // Robots fetches through the raw path, not through fetchPage, or checking
    // robots would require checking robots. It is not page-cached — its policy
    // lives in its own table with its own TTL — but it DOES go through the
    // limiter, because it is a real request to the origin like any other.
    //
    // `format: "raw"` because robots.txt is a text file, not a document. Read
    // through the DOM it depends on Chromium choosing to render the origin's
    // content-type, and an origin that serves it as a download would produce an
    // empty policy — which parses as "no restrictions" and would quietly hand us
    // a site we were never given permission to crawl.
    this.robots = new Robots(config, this.store, (url) =>
      this.fetchThroughLimiter({ url, format: "raw" }, false),
    )
  }

  /** One long-lived browser process; the cookie jars live in per-domain contexts. */
  private async ensureBrowser(): Promise<PlaywrightBrowser> {
    if (this.restarting) await this.restarting
    if (this.browser) return this.browser
    if (this.starting) return this.starting

    // Bring-your-own-browser: attach to one that is already running rather than
    // launching our own. We cannot pass it flags, so the egress proxy is not in
    // the path — index.ts says so loudly at startup.
    if (this.config.cdpUrl) {
      this.starting = chromium
        .connectOverCDP(this.config.cdpUrl)
        .then((browser) => {
          browser.on("disconnected", () => {
            this.browser = null
            this.contexts.clear()
          })
          this.browser = browser
          return browser
        })
        .finally(() => {
          this.starting = null
        })
      return this.starting
    }

    this.starting = this.proxy
      .listen()
      .then(() =>
        chromium.launch({
          headless: this.config.headless,
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
      .then((browser) => {
        browser.on("disconnected", () => {
          this.browser = null
          this.contexts.clear()
        })
        this.browser = browser
        return browser
      })
      .finally(() => {
        this.starting = null
      })

    return this.starting
  }

  /**
   * The persistent profile, per domain.
   *
   * Cookie jars stay separated because each domain gets its own context — a
   * tracker on one site cannot see state from another. And each context is
   * seeded from that domain's stored `storageState`, so we arrive as a returning
   * visitor rather than a brand-new one.
   *
   * That second half is the part that matters most. A per-domain context which
   * forgot its cookies on every restart would be strictly worse than the single
   * shared profile it replaced — most "Cloudflare blocked me" cases are a
   * missing user agent, no cookie jar and no JavaScript, and the cookie jar is
   * the part we own.
   *
   * No stealth plugins, no fingerprint patching, no UA string games. Stock.
   */
  private async contextFor(host: string): Promise<BrowserContext> {
    // Attached to someone else's browser: use the context it already has. A
    // `newContext()` here would be a blank incognito profile with none of the
    // cookies or history that are the entire reason for connecting, so
    // per-domain jars are given up deliberately — it is one browser, one jar,
    // and it is the user's.
    if (this.config.cdpUrl) {
      const browser = await this.ensureBrowser()
      return browser.contexts()[0] ?? (await browser.newContext())
    }

    const existing = this.contexts.get(host)
    if (existing) {
      // Refresh LRU position.
      this.contexts.delete(host)
      this.contexts.set(host, existing)
      return existing
    }

    const browser = await this.ensureBrowser()
    await mkdir(this.config.profileDir, { recursive: true }).catch(() => {})

    const statePath = join(this.config.profileDir, stateFileName(host))
    const context = await browser.newContext(existsSync(statePath) ? { storageState: statePath } : {})

    this.contexts.set(host, context)
    await this.evictExcessContexts()
    return context
  }

  private async evictExcessContexts(): Promise<void> {
    while (this.contexts.size > this.config.maxContexts) {
      const oldest = this.contexts.keys().next().value as string | undefined
      if (oldest === undefined) return
      await this.retireContext(oldest)
    }
  }

  private async retireContext(host: string): Promise<void> {
    const context = this.contexts.get(host)
    this.contexts.delete(host)
    if (!context) return
    await this.saveState(host, context)
    await context.close().catch(() => {})
  }

  /** Cookies are only persistent if they are written down. */
  private async saveState(host: string, context: BrowserContext): Promise<void> {
    // Their browser manages its own profile on disk. Writing our copy would be
    // both pointless and presumptuous.
    if (this.config.cdpUrl) return
    try {
      await mkdir(this.config.profileDir, { recursive: true })
      await context.storageState({ path: join(this.config.profileDir, stateFileName(host)) })
    } catch {
      // A profile we could not save is a slower next visit, not a failed fetch.
    }
  }

  async isAlive(): Promise<boolean> {
    return this.browser !== null
  }

  /** What an operator wants to know without making a fetch to find out. */
  async stats(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      // Which kind of browser is answering. A `blocked_challenge` from a
      // launched browser means "try an attached one"; from an attached one it
      // means stop. Same code, opposite correct action.
      mode: fetchMode(this.config),
      browser: this.browser ? "up" : "not started",
      contexts: this.contexts.size,
      rss_mb: Math.round((await this.browserRssBytes()) / 1_048_576),
      uptime_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      restarts: this.restarts,
      last_restart: this.lastRestartAt,
      domains: this.store.domainSummary(),
    }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null

    if (this.config.cdpUrl) {
      // Disconnect, do not close. Shutting down a browser the user is sitting
      // in front of would be a rude way to stop a background service.
      if (browser) await browser.close().catch(() => {})
    } else {
      for (const host of [...this.contexts.keys()]) await this.retireContext(host)
      if (browser) await browser.close().catch(() => {})
    }

    await this.proxy.close()
    this.store.close()
  }

  /** The proxy address appears in the browser's command line and nowhere else. */
  private async browserRssBytes(): Promise<number> {
    if (!this.browser || this.config.cdpUrl) return 0
    return browserTreeRssBytes(`--proxy-server=${this.proxy.address}`)
  }

  /**
   * Restart the browser when it has grown too large. Chromium leaks over days
   * and this is a multi-day process.
   *
   * It drains rather than truncates: in-flight fetches finish, and their cookies
   * are written down, before anything is closed.
   */
  private async restartIfBloated(): Promise<void> {
    // Not ours to restart, and not ours to have an opinion about.
    if (this.config.cdpUrl) return
    if (this.restarting || !this.browser) return

    const bytes = await this.browserRssBytes()
    const limit = this.config.memoryRestartMb * 1_048_576
    if (bytes < limit) return

    const reason = `browser tree at ${Math.round(bytes / 1_048_576)}MB exceeded ${this.config.memoryRestartMb}MB`
    this.restarting = this.drainAndRestart(reason).finally(() => {
      this.restarting = null
    })
  }

  private async drainAndRestart(reason: string): Promise<void> {
    await this.gate.idle()

    for (const host of [...this.contexts.keys()]) await this.retireContext(host)
    const browser = this.browser
    this.browser = null
    if (browser) await browser.close().catch(() => {})

    this.restarts += 1
    this.lastRestartAt = new Date().toISOString()
    console.log(
      JSON.stringify({ at: this.lastRestartAt, event: "browser_restarted", reason, restarts: this.restarts }),
    )
  }

  async fetchPage(request: FetchRequest): Promise<FetchResult> {
    // Validate before the browser is touched at all. The proxy would refuse this
    // anyway; doing it here means an obviously bad URL costs nothing and gets a
    // better error than a failed navigation would produce.
    const verdict = await validateUrl(request.url, this.config.allowHosts)
    // A host that does not resolve is an unreachable origin, not a bad URL, and
    // the codes say opposite things about retrying.
    if (!verdict.ok) {
      return result(verdict.refusal === "unreachable" ? "origin_error" : "invalid_url", { detail: verdict.reason })
    }

    // The cache comes before everything, because a hit must cost nothing — no
    // network, and no robots round trip either. We only ever store pages we were
    // allowed to fetch in the first place.
    const maxAge = request.maxAge ?? this.config.cacheTtlSeconds
    const hit = this.store.lookupPage(request.url, maxAge)
    // `wait_for` means "this content is not complete until the selector exists".
    // That has to hold for a cached answer as well, or a caller who asked to
    // wait for award cards could be handed a stored page that never had any and
    // have no way to tell. Verified without touching the network.
    if (
      hit &&
      // A row cached as markdown cannot answer `raw`, and vice versa — the two
      // live in different columns and serving the wrong one returns an empty
      // string dressed as a hit.
      satisfies(hit, request.format) &&
      (!request.waitFor || (await this.cachedContentSatisfies(hit.html, request.waitFor)))
    ) {
      return result("ok", {
        status: hit.status,
        url_final: hit.urlFinal,
        fetched_at: hit.fetchedAt,
        from_cache: true,
        content: render({ html: hit.html, text: hit.text, raw: hit.raw }, request.format),
      })
    }

    // A benched or disabled domain is refused before anything reaches it — not
    // even its robots.txt. Backing off means backing off.
    const host = verdict.url.hostname.toLowerCase()
    const available = this.limiter.gate(host)
    if (!available.allowed) return result(available.code, { detail: available.detail })

    // Policy before network. A disallowed path must cost the origin nothing at
    // all beyond the robots.txt we already had to read.
    const permission = await this.robots.check(verdict.url)
    if (!permission.allowed) {
      return result(permission.code ?? "blocked_robots", { detail: permission.detail })
    }

    return this.fetchThroughLimiter(request, true)
  }

  /**
   * A list, run **sequentially through the limiter** rather than in parallel.
   * That is a feature: a batch must not be able to become an accidental flood.
   *
   * Each URL is independent. A batch of thirty where one domain is benched
   * returns twenty-nine results and one `domain_benched`, not nothing — the
   * caller asked about thirty pages and deserves what we know about all of them.
   */
  async fetchPages(requests: FetchRequest[]): Promise<BatchResult> {
    const results: (FetchResult & { url: string })[] = []
    for (const request of requests) {
      results.push({ url: request.url, ...(await this.fetchPage(request)) })
    }
    return { code: "ok", results }
  }

  /**
   * The cheap probe — the tool that stops agents wasting time, and the one the
   * consumer documentation says to call first.
   *
   * It makes **no** outbound request. It must not fetch the page to discover
   * whether the page can be fetched, and it must not fetch robots.txt to
   * discover the policy: an unknown answer is honest, and a probe with a network
   * cost is not a probe.
   */
  async checkReachable(url: string): Promise<ReachableResult> {
    const verdict = await validateUrl(url, this.config.allowHosts)
    if (!verdict.ok) {
      return {
        code: verdict.refusal === "unreachable" ? "origin_error" : "invalid_url",
        url,
        from_cache: false,
        fetched_at: null,
        domain: "available",
        robots: "unknown",
        detail: verdict.reason,
      }
    }

    const host = verdict.url.hostname.toLowerCase()
    const domain = this.limiter.describe(host)
    const robots = this.robots.peek(verdict.url)
    const cached = this.store.lookupPage(url, this.config.cacheTtlSeconds)

    const base = {
      url,
      from_cache: cached !== null,
      fetched_at: cached?.fetchedAt ?? null,
      domain,
      robots,
    }

    // A cache hit needs neither the domain nor its policy — it costs nothing and
    // touches nobody, so it is reachable whatever else is true.
    if (cached) return { code: "ok", ...base }

    if (domain !== "available") {
      return { code: "domain_benched", ...base, detail: `${host} is ${domain}` }
    }
    if (robots === "disallowed") {
      return { code: "blocked_robots", ...base, detail: `robots.txt for ${verdict.url.origin} disallows this path` }
    }

    return { code: "ok", ...base }
  }

  /**
   * Read-only cache query. No network, no rate limit, free — so it can be used
   * freely for re-reads. A miss is a clean miss, not an error.
   */
  cacheLookup(url: string, format: Format, maxAge: number | undefined): FetchResult {
    const cached = this.store.lookupPage(url, maxAge ?? this.config.cacheTtlSeconds)
    if (!cached) return result("ok", { detail: "not cached" })
    // Cached, but not in the form asked for. A miss for this format is still a
    // clean miss; claiming a hit and returning "" would be the worse answer.
    if (!satisfies(cached, format)) return result("ok", { detail: `not cached as ${format}` })

    return result("ok", {
      status: cached.status,
      url_final: cached.urlFinal,
      fetched_at: cached.fetchedAt,
      from_cache: true,
      content: render({ html: cached.html, text: cached.text, raw: cached.raw }, format),
    })
  }

  /**
   * Every request that actually reaches an origin passes through here.
   *
   * The spacing wait happens BEFORE the concurrency semaphore, so a fetch that
   * is politely waiting five seconds is not also holding one of the two
   * available browser slots.
   */
  private async fetchThroughLimiter(request: FetchRequest, cacheable: boolean): Promise<FetchResult> {
    const host = new URL(request.url).hostname.toLowerCase()

    const slot = this.limiter.acquire(host)
    if (!slot.allowed) {
      return result(slot.code, { detail: slot.detail, retry_after: slot.retryAfter })
    }
    if (slot.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, slot.waitMs))

    try {
      return await this.gate.run(() => this.navigate(request, cacheable))
    } finally {
      // Checked after the slot is released, so the drain can actually drain.
      void this.restartIfBloated()
    }
  }

  private async navigate(request: FetchRequest, cacheable: boolean): Promise<FetchResult> {
    const host = new URL(request.url).hostname.toLowerCase()
    const context = await this.contextFor(host)
    const page = await context.newPage()
    const startedAt = Date.now()

    /** Hops this page's guard refused. Only used in attached mode. */
    const blockedHops: string[] = []

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
    // Attached mode has no egress proxy, so validation moves onto the page.
    // This catches the submitted URL and every subresource; it does NOT catch a
    // same-document redirect hop, because Chromium follows those internally and
    // never re-enters routing. That gap is why the proxy exists, and why
    // docs/BYOB.md tells you how to put it back if you want it.
    if (this.config.cdpUrl) await this.installPageGuard(page, blockedHops)

    /**
     * A download the origin started instead of serving a document.
     *
     * Chromium aborts the navigation for these, so `page.goto()` throws and
     * there is no DOM and no readable response body — the bytes exist only as a
     * download. For `format: "raw"` those bytes are exactly what was asked for.
     */
    let pendingDownload: Download | null = null
    page.on("download", (download) => {
      pendingDownload = download
    })

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
        //
        // This stays ahead of the download check below: a refusal is a security
        // verdict and must never be overtaken by a body that arrived anyway.
        if (blockedHops.length > 0) {
          return result("invalid_url", { detail: `blocked at the hop: ${blockedHops.join("; ")}` })
        }
        const refused = this.proxy
          .rejectionsSince(startedAt)
          .filter((rejection) => requestedHosts.has(rejection.host.toLowerCase()))
        if (refused.length > 0) {
          return result("invalid_url", { detail: `blocked at the hop: ${describe(refused)}` })
        }

        // A download is not a failed navigation. The origin answered; Chromium
        // simply declined to make a page out of what it sent.
        //
        // `page.goto()` rejects the moment Chromium decides it is a download,
        // which is usually BEFORE the download event is dispatched — so the
        // handler above has often not run yet and we have to wait for it.
        const download =
          pendingDownload ??
          (isDownloadError(error)
            ? await page.waitForEvent("download", { timeout: DOWNLOAD_EVENT_TIMEOUT_MS }).catch(() => null)
            : null)
        if (download) {
          return await this.completeDownload(request, cacheable, host, download, lastMainResponse)
        }
        if (error instanceof playwrightErrors.TimeoutError) {
          return result("timeout", { detail: `navigation exceeded ${this.config.navTimeoutMs}ms` })
        }
        // A refused connection, a DNS failure, a TLS error. Not a timeout: the
        // render budget was never the problem, and calling it one poisons the
        // reachability data by making a dead host look like a slow one.
        return result("origin_error", { detail: `navigation failed: ${(error as Error).message}` })
      }

      if (blockedHops.length > 0) {
        return result("invalid_url", { detail: `blocked at the hop: ${blockedHops.join("; ")}` })
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

      // A refusal from the origin benches the domain. Recorded here, after the
      // proxy-rejection check above, so our own 403 is never mistaken for one.
      this.limiter.recordOutcome(host, status)

      const extracted = await extract(page)

      // The body underneath the document. Read when it was asked for, and also
      // when there is no document — that is the only way to tell "the origin
      // sent nothing" from "the browser did not make a page out of what it sent",
      // and those two deserve different answers.
      const wantsRaw = request.format === "raw"
      let raw = wantsRaw || extracted.html === "" ? await readBody(settled) : null

      // Classified against whichever we have. An interstitial served for a URL
      // Chromium would not render — a challenged robots.txt, say — still carries
      // its markers in the bytes.
      const blocked = this.classifyBlock(status, extracted.html || raw || "", settled)
      if (blocked) return result(blocked.code, { status, url_final: page.url(), detail: blocked.detail })

      let content = render({ ...extracted, raw }, request.format)

      // Nothing to show is never returned as `ok` without first finding out why.
      // A consumer cannot tell a genuinely blank page from a fetch that quietly
      // produced nothing, and that is the one failure they cannot detect.
      //
      // `text` is the trigger rather than `content`, because Chromium invents a
      // `<html><head></head><body></body></html>` skeleton for a zero-byte
      // response — so `format: "html"` of nothing at all looks non-empty.
      if (content === "" || extracted.text === "") {
        if (raw === null) raw = await readBody(settled)
        content = render({ ...extracted, raw }, request.format)

        const emptiness = describeEmptiness(status, extracted.html, raw, settled)
        if (emptiness && !(wantsRaw && content !== "")) {
          return result("origin_error", { status, url_final: page.url(), detail: emptiness })
        }
      }

      // The browser navigates redirects itself, so its own URL is the end of the
      // chain, fragment included.
      const urlFinal = page.url()
      const fetchedAt = new Date().toISOString()

      // Write the jar down now rather than at shutdown, so an ungraceful stop
      // does not cost us the cookies that make us a returning visitor.
      await this.saveState(host, context)

      // Only successful fetches are cached. A challenge or a bench is a state of
      // the domain, not a property of the page, and #6 owns how long those last
      // — caching them here would quietly turn a one-hour bench into a 7-day one.
      if (cacheable) {
        this.store.storePage(request.url, {
          urlFinal,
          status,
          html: extracted.html,
          text: extracted.text,
          raw,
          fetchedAt,
          fetchedAtMs: Date.now(),
        })
      }

      return result("ok", { status, url_final: urlFinal, fetched_at: fetchedAt, content })
    } finally {
      await page.close().catch(() => {})
    }
  }

  /**
   * The origin sent a file rather than a page.
   *
   * Only `raw` can be answered from a download — there is no DOM to render into
   * markdown, text or HTML, and returning an empty string for those is the
   * silence-dressed-as-success this format exists to remove.
   */
  private async completeDownload(
    request: FetchRequest,
    cacheable: boolean,
    host: string,
    download: Download,
    response: Response | null,
  ): Promise<FetchResult> {
    const status = response?.status() ?? null
    this.limiter.recordOutcome(host, status)

    const urlFinal = download.url()
    try {
      if (request.format !== "raw") {
        return result("origin_error", {
          status,
          url_final: urlFinal,
          detail:
            `the origin served a download (${download.suggestedFilename()}) rather than a document; ` +
            `request it with format: "raw"`,
        })
      }

      const raw = await readDownload(download)
      if (raw === null) {
        return result("origin_error", {
          status,
          url_final: urlFinal,
          detail: `the origin started a download that could not be read (${download.suggestedFilename()})`,
        })
      }

      const fetchedAt = new Date().toISOString()
      if (cacheable) {
        // No DOM to store. `storePage` keeps whatever html and text the row
        // already had rather than blanking them.
        this.store.storePage(request.url, {
          urlFinal,
          status,
          html: "",
          text: "",
          raw,
          fetchedAt,
          fetchedAtMs: Date.now(),
        })
      }

      return result("ok", { status, url_final: urlFinal, fetched_at: fetchedAt, content: raw })
    } finally {
      // Do not leave files behind. In attached mode this is the user's own
      // machine and their own Downloads folder — see docs/BYOB.md.
      await download.delete().catch(() => {})
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
    // A throwaway context: this is parsing, not visiting, and it must not
    // deposit anything in a domain's jar.
    const context = await this.contextFor("__verify")
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

  /**
   * URL validation for a browser we did not launch.
   *
   * A weaker guarantee than the proxy — see the note at the call site — but a
   * great deal better than nothing, and it costs the page nothing when every
   * request is legitimate.
   */
  private async installPageGuard(page: Page, blockedHops: string[]): Promise<void> {
    await page.route("**/*", async (route) => {
      const target = route.request().url()
      const verdict = route.request().isNavigationRequest()
        ? await validateUrl(target, this.config.allowHosts)
        : validateUrlSyntax(target, this.config.allowHosts)

      if (!verdict.ok) {
        // Only a security refusal is "blocked at the hop". A hop that simply
        // does not resolve is aborted too — we cannot fetch it either way — but
        // it is left to fail the navigation normally, so it is reported as an
        // unreachable origin rather than as something we refused on purpose.
        if (verdict.refusal === "invalid_url") blockedHops.push(verdict.reason)
        await route.abort("blockedbyclient").catch(() => {})
        return
      }
      await route.continue().catch(() => {})
    })
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

  /** Maps what the origin said onto the closed code set. */
  private classifyBlock(
    status: number | null,
    html: string,
    response: Response | null,
  ): { code: "blocked_challenge" | "not_found" | "domain_benched" | "origin_error"; detail: string } | null {
    if (status === 404) return { code: "not_found", detail: "origin returned 404" }

    // By now settleChallenge has given any interstitial its budget to clear, so
    // a marker still being here means it did not.
    const marker = this.challengeMarker(html, response)
    if (marker) {
      return {
        code: "blocked_challenge",
        detail: `interstitial did not clear (${marker}) — ${challengeAdvice(this.config)}`,
      }
    }

    if (status === 403) {
      return { code: "blocked_challenge", detail: `origin returned 403 — ${challengeAdvice(this.config)}` }
    }

    // Benching exists now, so an origin 429 says what it is: we have been asked
    // to back off, and we have. Subsequent requests get domain_benched from the
    // gate before any of this runs.
    if (status === 429) {
      return { code: "domain_benched", detail: "origin returned 429; the domain is benched" }
    }

    // Anything else non-2xx is the origin being broken rather than refusing us.
    // Returning `ok` here, as this did before, meant a consumer honouring the
    // contract would parse an error page as content.
    if (status !== null && (status < 200 || status >= 300)) {
      return { code: "origin_error", detail: `origin returned ${status}` }
    }

    return null
  }
}

function describe(rejections: { host: string; reason: string }[]): string {
  return rejections.map((entry) => entry.reason).join("; ")
}

/**
 * The response body as the origin sent it.
 *
 * Read off the response the browser already has, which matters more than it
 * looks: `context.request.get()` would be a second request, from Node rather
 * than from the browser, and on a challenged host it is refused — measured, on
 * `scholarshipscanada.com`, where the browser gets 200 and the request API gets
 * 403. Reading the body we already fetched costs the origin nothing extra and
 * carries the browser's own connection, cookies and TLS by construction.
 *
 * Decoded as UTF-8. Every format this serves — XML, JSON, robots.txt — is UTF-8
 * in practice, and a mis-decoded body is a visible problem rather than a silent
 * one.
 */
/** Chromium aborts a navigation it decides is a download, and says so in the message. */
function isDownloadError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Download is starting")
}

/**
 * Why there is nothing to return, or null if the emptiness is the page's own.
 *
 * Three different things look identical from the outside, and only one of them
 * is a legitimate `ok`:
 *
 * - the origin sent no bytes at all,
 * - it sent bytes the browser would not turn into a document,
 * - it sent a real page that happens to have no text in the requested format.
 */
function describeEmptiness(
  status: number | null,
  html: string,
  raw: string | null,
  response: Response | null,
): string | null {
  if (raw === null || raw === "") {
    return `origin returned ${status ?? "no status"} with an empty body`
  }
  if (html === "") {
    const contentType = response?.headers()["content-type"] ?? "an unknown content type"
    return (
      `the origin served ${contentType}, which the browser did not render as a document; ` +
      `${raw.length} bytes are available with format: "raw"`
    )
  }
  return null
}

/** A download is bytes on disk rather than a response body, so it is read as a stream. */
async function readDownload(download: Download): Promise<string | null> {
  try {
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length
      // A download is untrusted input of unbounded size, and this one is headed
      // for a SQLite row and a JSON response. Refuse rather than exhaust memory.
      if (bytes > MAX_RAW_BYTES) return null
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString("utf8")
  } catch {
    return null
  }
}

async function readBody(response: Response | null): Promise<string | null> {
  if (!response) return null
  try {
    const body = await response.body()
    if (body.length > MAX_RAW_BYTES) return null
    return body.toString("utf8")
  } catch {
    // Chromium discards some bodies once the page moves on. A body we cannot
    // read is not a body we can serve.
    return null
  }
}
