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
`

export class Store {
  private readonly db: DatabaseSync

  constructor(config: Config) {
    this.db = new DatabaseSync(config.cachePath)
    // WAL so a long read cannot block a write, and the store survives an
    // ungraceful container stop.
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec(SCHEMA)
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
      fetchedAt: row.fetched_at,
      fetchedAtMs: row.fetched_at_ms,
    }
  }

  storePage(requested: string, page: CachedPage): void {
    this.db
      .prepare(
        `INSERT INTO pages (url_final, status, html, text, fetched_at, fetched_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url_final) DO UPDATE SET
           status = excluded.status, html = excluded.html, text = excluded.text,
           fetched_at = excluded.fetched_at, fetched_at_ms = excluded.fetched_at_ms`,
      )
      .run(page.urlFinal, page.status, page.html, page.text, page.fetchedAt, page.fetchedAtMs)

    this.db
      .prepare(
        `INSERT INTO aliases (requested, url_final, fetched_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(requested) DO UPDATE SET
           url_final = excluded.url_final, fetched_at_ms = excluded.fetched_at_ms`,
      )
      .run(requested, page.urlFinal, page.fetchedAtMs)
  }

  lookupRobots(origin: string, ttlSeconds: number): CachedRobots | null {
    const row = this.db.prepare("SELECT * FROM robots WHERE origin = ?").get(origin) as
      | {
          rules: string | null
          failure_code: string | null
          failure_detail: string | null
          fetched_at_ms: number
        }
      | undefined
    if (!row) return null
    if (Date.now() - row.fetched_at_ms > ttlSeconds * 1000) return null

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

  close(): void {
    this.db.close()
  }
}
