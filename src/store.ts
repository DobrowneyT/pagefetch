/**
 * The durable store — the cache, and the one place persistent state lives.
 *
 * ## Why the cache is the primary feature
 *
 * At a weekly collection cadence a 7-day TTL means each page is fetched exactly
 * once. This is not an optimisation bolted onto the fetching; it is the thing
 * that makes the fetching polite enough to run at all.
 *
 * ## Why one store rather than two
 *
 * Content-addressed files on a volume would be a simpler page cache. But the
 * state that has to survive a restart is not only page bodies — robots policy
 * lives here too, and the bench and disable counters from #6 will as well. Two
 * stores means two things to keep consistent, and `cache_lookup` (#7) wants
 * real queryability anyway.
 *
 * ## Why HTML and text, but not markdown
 *
 * Both `html` and `text` need the browser: one is the rendered DOM, the other is
 * `innerText`, which has no faithful equivalent over a string. Markdown is
 * derived from the stored HTML in Node. Storing those two means **a change of
 * format is not a refetch**, which is the point — asking for the same page as
 * markdown after fetching it as HTML should cost the origin nothing.
 *
 * `raw` is stored alongside rather than fetched fresh, for that same reason: a
 * sitemap is a page like any other and re-reading it should cost the origin
 * nothing. It is nullable because it is only captured when it was asked for, and
 * a row that has it keeps it — see the COALESCE in `storePage`.
 */
import { DatabaseSync } from "node:sqlite"
import type { Config } from "./config.js"
import type { Code } from "./codes.js"
import type { Rule } from "./robots.js"

export interface CachedPage {
  urlFinal: string
  status: number | null
  html: string
  text: string
  /** The response body as the origin sent it. Null unless a `raw` fetch stored one. */
  raw: string | null
  /** When the origin was actually read. On a hit this is what the caller is told. */
  fetchedAt: string
  fetchedAtMs: number
}

export interface CachedRobots {
  rules: Rule[] | null
  failure?: { code: Code; detail: string }
  fetchedAtMs: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  url_final     TEXT PRIMARY KEY,
  status        INTEGER,
  html          TEXT NOT NULL,
  text          TEXT NOT NULL,
  -- Nullable, and added by migration rather than only here: an existing
  -- database predates this column and CREATE TABLE IF NOT EXISTS will not
  -- add it. See migrate() below.
  raw           TEXT,
  fetched_at    TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL
);

-- Requested URL to the end of its redirect chain, so two URLs that land in the
-- same place share one entry rather than fetching it twice.
CREATE TABLE IF NOT EXISTS aliases (
  requested     TEXT PRIMARY KEY,
  url_final     TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS robots (
  origin         TEXT PRIMARY KEY,
  rules          TEXT,
  failure_code   TEXT,
  failure_detail TEXT,
  fetched_at_ms  INTEGER NOT NULL
);

-- One row per request we have committed to making, recorded at its SCHEDULED
-- time rather than when it completes, so the hourly quota and the spacing stay
-- correct when several fetches arrive at once.
CREATE TABLE IF NOT EXISTS domain_requests (
  host  TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS domain_requests_idx ON domain_requests(host, at_ms);

-- One row per time a domain refused us. Blocks accumulate toward disabling.
CREATE TABLE IF NOT EXISTS domain_blocks (
  host  TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS domain_blocks_idx ON domain_blocks(host, at_ms);

-- Benched and disabled are different states. Benched is a cooling-off we impose
-- on ourselves and it expires; disabled is the escalation and requires a person.
CREATE TABLE IF NOT EXISTS domain_state (
  host             TEXT PRIMARY KEY,
  benched_until_ms INTEGER NOT NULL DEFAULT 0,
  disabled         INTEGER NOT NULL DEFAULT 0,
  disabled_at_ms   INTEGER
);
`

export class Store {
  private readonly db: DatabaseSync

  constructor(config: Config) {
    this.db = new DatabaseSync(config.cachePath)
    // WAL so a long read cannot block a write, and the store survives an
    // ungraceful container stop.
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /**
   * Columns added after the first release.
   *
   * The cache is the primary feature, so a schema change must not throw it away.
   * `ALTER TABLE ADD COLUMN` on a nullable column keeps every cached page.
   */
  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(pages)").all() as { name: string }[]
    if (!columns.some((column) => column.name === "raw")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN raw TEXT")
    }
  }

  /**
   * A hit is content served with **no network traffic at all**. Nothing in here
   * revalidates against the origin — a response that did would not be a hit,
   * whatever the flag said.
   */
  lookupPage(requested: string, maxAgeSeconds: number): CachedPage | null {
    if (maxAgeSeconds <= 0) return null

    const alias = this.db.prepare("SELECT url_final FROM aliases WHERE requested = ?").get(requested) as
      | { url_final: string }
      | undefined
    const urlFinal = alias?.url_final ?? requested

    const row = this.db.prepare("SELECT * FROM pages WHERE url_final = ?").get(urlFinal) as
      | {
          url_final: string
          status: number | null
          html: string
          text: string
          raw: string | null
          fetched_at: string
          fetched_at_ms: number
        }
      | undefined
    if (!row) return null

    if (Date.now() - row.fetched_at_ms > maxAgeSeconds * 1000) return null

    return {
      urlFinal: row.url_final,
      status: row.status,
      html: row.html,
      text: row.text,
      raw: row.raw,
      fetchedAt: row.fetched_at,
      fetchedAtMs: row.fetched_at_ms,
    }
  }

  storePage(requested: string, page: CachedPage): void {
    this.db
      .prepare(
        // A fetch that captured only one side must not erase the other. A `raw`
        // fetch of an XML document has no DOM, and a markdown fetch has no raw
        // body; either overwriting the other would turn a hit into a refetch.
        `INSERT INTO pages (url_final, status, html, text, raw, fetched_at, fetched_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url_final) DO UPDATE SET
           status = excluded.status,
           html = CASE WHEN excluded.html = '' THEN pages.html ELSE excluded.html END,
           text = CASE WHEN excluded.text = '' THEN pages.text ELSE excluded.text END,
           raw  = COALESCE(excluded.raw, pages.raw),
           fetched_at = excluded.fetched_at, fetched_at_ms = excluded.fetched_at_ms`,
      )
      .run(page.urlFinal, page.status, page.html, page.text, page.raw, page.fetchedAt, page.fetchedAtMs)

    this.db
      .prepare(
        `INSERT INTO aliases (requested, url_final, fetched_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(requested) DO UPDATE SET
           url_final = excluded.url_final, fetched_at_ms = excluded.fetched_at_ms`,
      )
      .run(requested, page.urlFinal, page.fetchedAtMs)
  }

  /**
   * The policy a fetch may act on: the stored one, or nothing if it has lapsed.
   *
   * The TTL is not a tuning knob. RFC 9309 §2.4 caps a cached `robots.txt` at
   * twenty-four hours, so a lapsed entry must not be allowed to decide a fetch,
   * however recently it lapsed and however unlikely the site is to have changed.
   */
  lookupRobots(origin: string, ttlSeconds: number): CachedRobots | null {
    const entry = this.peekRobots(origin)
    if (!entry) return null
    if (Date.now() - entry.fetchedAtMs > ttlSeconds * 1000) return null
    return entry
  }

  /**
   * The stored policy whatever its age, for the probe to reason about.
   *
   * A lapsed entry may not decide a fetch, but "we read this yesterday and it
   * said no" is still a fact, and one the caller of `check_reachable` would
   * plainly rather have than a bare `unknown`. Telling them costs nothing and
   * changes no fetch decision — `lookupRobots` is still the only door into the
   * fetch path, and it still shuts at the TTL.
   */
  peekRobots(origin: string): CachedRobots | null {
    const row = this.db.prepare("SELECT * FROM robots WHERE origin = ?").get(origin) as
      | {
          rules: string | null
          failure_code: string | null
          failure_detail: string | null
          fetched_at_ms: number
        }
      | undefined
    if (!row) return null

    return {
      rules: row.rules ? (JSON.parse(row.rules) as Rule[]) : null,
      ...(row.failure_code
        ? { failure: { code: row.failure_code as Code, detail: row.failure_detail ?? "" } }
        : {}),
      fetchedAtMs: row.fetched_at_ms,
    }
  }

  storeRobots(origin: string, entry: CachedRobots): void {
    this.db
      .prepare(
        `INSERT INTO robots (origin, rules, failure_code, failure_detail, fetched_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(origin) DO UPDATE SET
           rules = excluded.rules, failure_code = excluded.failure_code,
           failure_detail = excluded.failure_detail, fetched_at_ms = excluded.fetched_at_ms`,
      )
      .run(
        origin,
        entry.rules ? JSON.stringify(entry.rules) : null,
        entry.failure?.code ?? null,
        entry.failure?.detail ?? null,
        entry.fetchedAtMs,
      )
  }

  // --- domain politeness state -------------------------------------------

  domainState(host: string): { benchedUntilMs: number; disabled: boolean; disabledAtMs: number | null } {
    const row = this.db.prepare("SELECT * FROM domain_state WHERE host = ?").get(host) as
      | { benched_until_ms: number; disabled: number; disabled_at_ms: number | null }
      | undefined
    return {
      benchedUntilMs: row?.benched_until_ms ?? 0,
      disabled: Boolean(row?.disabled),
      disabledAtMs: row?.disabled_at_ms ?? null,
    }
  }

  setBench(host: string, untilMs: number): void {
    this.db
      .prepare(
        `INSERT INTO domain_state (host, benched_until_ms) VALUES (?, ?)
         ON CONFLICT(host) DO UPDATE SET benched_until_ms = excluded.benched_until_ms`,
      )
      .run(host, untilMs)
  }

  setDisabled(host: string, disabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO domain_state (host, disabled, disabled_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET disabled = excluded.disabled, disabled_at_ms = excluded.disabled_at_ms`,
      )
      .run(host, disabled ? 1 : 0, disabled ? Date.now() : null)
  }

  /** Clears bench, disable, and the accumulated blocks. The operator's undo. */
  enableDomain(host: string): void {
    this.db.prepare("DELETE FROM domain_state WHERE host = ?").run(host)
    this.db.prepare("DELETE FROM domain_blocks WHERE host = ?").run(host)
  }

  listDomains(): { host: string; benchedUntilMs: number; disabled: boolean; blocks: number }[] {
    const rows = this.db
      .prepare(
        `SELECT s.host, s.benched_until_ms, s.disabled,
                (SELECT COUNT(*) FROM domain_blocks b WHERE b.host = s.host) AS blocks
         FROM domain_state s ORDER BY s.host`,
      )
      .all() as { host: string; benched_until_ms: number; disabled: number; blocks: number }[]
    return rows.map((row) => ({
      host: row.host,
      benchedUntilMs: row.benched_until_ms,
      disabled: Boolean(row.disabled),
      blocks: row.blocks,
    }))
  }

  /** Counts for the health endpoint, so an operator can see trouble accumulating. */
  domainSummary(): { benched: number; disabled: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN disabled = 1 THEN 1 ELSE 0 END) AS disabled,
           SUM(CASE WHEN disabled = 0 AND benched_until_ms > ? THEN 1 ELSE 0 END) AS benched
         FROM domain_state`,
      )
      .get(Date.now()) as { benched: number | null; disabled: number | null }
    return { benched: row.benched ?? 0, disabled: row.disabled ?? 0 }
  }

  recordRequestAt(host: string, atMs: number): void {
    this.db.prepare("INSERT INTO domain_requests (host, at_ms) VALUES (?, ?)").run(host, atMs)
  }

  /** The latest time we have already committed to hitting this host. */
  lastScheduledMs(host: string): number {
    const row = this.db.prepare("SELECT MAX(at_ms) AS latest FROM domain_requests WHERE host = ?").get(host) as
      | { latest: number | null }
      | undefined
    return row?.latest ?? 0
  }

  countRequestsSince(host: string, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM domain_requests WHERE host = ? AND at_ms >= ?")
      .get(host, sinceMs) as { n: number }
    return row.n
  }

  oldestRequestSince(host: string, sinceMs: number): number | null {
    const row = this.db
      .prepare("SELECT MIN(at_ms) AS oldest FROM domain_requests WHERE host = ? AND at_ms >= ?")
      .get(host, sinceMs) as { oldest: number | null } | undefined
    return row?.oldest ?? null
  }

  recordBlock(host: string, atMs: number): void {
    this.db.prepare("INSERT INTO domain_blocks (host, at_ms) VALUES (?, ?)").run(host, atMs)
  }

  countBlocksSince(host: string, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM domain_blocks WHERE host = ? AND at_ms >= ?")
      .get(host, sinceMs) as { n: number }
    return row.n
  }

  prune(requestsBeforeMs: number, blocksBeforeMs: number): void {
    this.db.prepare("DELETE FROM domain_requests WHERE at_ms < ?").run(requestsBeforeMs)
    this.db.prepare("DELETE FROM domain_blocks WHERE at_ms < ?").run(blocksBeforeMs)
  }

  close(): void {
    this.db.close()
  }
}
