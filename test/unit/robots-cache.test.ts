import test from "node:test"
import assert from "node:assert/strict"
import { loadConfig } from "../../src/config.js"
import { Robots } from "../../src/robots.js"
import type { CachedRobots, Store } from "../../src/store.js"
import type { Code, FetchResult } from "../../src/codes.js"

/**
 * What may be written to the robots cache, and what may not.
 *
 * ⚠️ The bug these pin, observed 2026-09-06 on
 * `crimeshub-2b4b0.firebaseapp.com`: an hourly quota was exhausted at 16:32,
 * the resulting `rate_limited` refusal was cached as though it were a fact
 * about the origin, and every fetch of that domain was refused from cache for
 * the next TWENTY-FOUR HOURS — still refusing at 01:47 the following morning
 * with the limiter window showing **0 of 20 used**, while the origin served
 * 200s to curl throughout.
 *
 * The failure mode is what makes it worth a test rather than a one-line fix:
 * it is indistinguishable from the remote host rate-limiting us, so the
 * natural response is to wait longer — which never helps, because nothing
 * re-checks until the TTL lapses.
 *
 * The distinction is the origin's business versus ours. A policy, a 404, a
 * timeout, a challenge — all facts about the ORIGIN, and RFC 9309 §2.4 lets
 * them stand for a day. `rate_limited` and `domain_benched` are facts about our
 * own momentary state and are stale seconds later.
 */

class FakeStore {
  readonly rows = new Map<string, CachedRobots>()
  peekRobots(origin: string): CachedRobots | null {
    return this.rows.get(origin) ?? null
  }
  lookupRobots(origin: string, ttlSeconds: number): CachedRobots | null {
    const row = this.rows.get(origin)
    if (!row) return null
    return Date.now() - row.fetchedAtMs < ttlSeconds * 1000 ? row : null
  }
  storeRobots(origin: string, entry: CachedRobots): void {
    this.rows.set(origin, entry)
  }
}

/** A Robots whose every robots.txt fetch fails with `code`, counting attempts. */
function withFailingFetch(code: Code, detail = "boom") {
  const config = loadConfig({ PAGEFETCH_TOKEN: "0123456789abcdef0123" } as NodeJS.ProcessEnv)
  const store = new FakeStore()
  let attempts = 0
  const fetchRaw = async (): Promise<FetchResult> => {
    attempts += 1
    return {
      code,
      status: null,
      url_final: null,
      fetched_at: new Date().toISOString(),
      from_cache: false,
      content: null,
      detail,
    } as FetchResult
  }
  const robots = new Robots(config, store as unknown as Store, fetchRaw)
  return { robots, store, attempts: () => attempts }
}

for (const code of ["rate_limited", "domain_benched"] as const) {
  test(`⚠️ a ${code} refusal is NEVER cached — it is our state, not the origin's`, async () => {
    const { robots, store } = withFailingFetch(code)

    const first = await robots.check(new URL("https://example.org/page"))
    assert.equal(first.allowed, false)
    assert.equal(first.code, code)

    // Nothing may have been written. If it were, the next 24 hours of fetches
    // to this origin would be refused from cache without consulting the
    // limiter that had by then drained.
    assert.equal(store.rows.size, 0, `${code} was written to the robots cache`)
  })

  test(`a ${code} refusal does not stop the NEXT attempt from re-reading robots.txt`, async () => {
    const { robots, attempts } = withFailingFetch(code)

    await robots.check(new URL("https://example.org/one"))
    await robots.check(new URL("https://example.org/two"))

    // Two attempts, not one served from a poisoned cache. This is the
    // property that was actually broken: recovery required the TTL to lapse.
    assert.equal(attempts(), 2)
  })
}

test("a genuine origin failure IS still cached — this is not a licence to re-hammer", async () => {
  // The counterweight. `timeout` is the origin failing to serve its policy,
  // which is its business and worth remembering; re-reading robots.txt on
  // every request to a slow host is precisely the flooding the cache prevents.
  const { robots, store, attempts } = withFailingFetch("timeout")

  await robots.check(new URL("https://example.org/one"))
  await robots.check(new URL("https://example.org/two"))

  assert.equal(store.rows.size, 1)
  assert.equal(attempts(), 1)
  assert.equal(store.rows.get("https://example.org")?.failure?.code, "timeout")
})

test("a successful policy is cached as before", async () => {
  const config = loadConfig({ PAGEFETCH_TOKEN: "0123456789abcdef0123" } as NodeJS.ProcessEnv)
  const store = new FakeStore()
  let attempts = 0
  const fetchRaw = async (): Promise<FetchResult> => {
    attempts += 1
    return {
      code: "ok",
      status: 200,
      url_final: null,
      fetched_at: new Date().toISOString(),
      from_cache: false,
      content: "User-agent: *\nDisallow: /private",
    } as FetchResult
  }
  const robots = new Robots(config, store as unknown as Store, fetchRaw)

  const ok = await robots.check(new URL("https://example.org/awards"))
  assert.equal(ok.allowed, true)
  const denied = await robots.check(new URL("https://example.org/private/x"))
  assert.equal(denied.allowed, false)
  assert.equal(denied.code, "blocked_robots")

  assert.equal(attempts, 1, "the policy should have been read once and cached")
})
