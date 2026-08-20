import test from "node:test"
import assert from "node:assert/strict"
import { loadConfig } from "../../src/config.js"
import { Robots } from "../../src/robots.js"
import type { CachedRobots, Store } from "../../src/store.js"
import type { FetchResult } from "../../src/codes.js"

// The probe is the tool that saves thirty rate-limited failures, so what it
// says has to survive being acted on. It said `code: "ok"` for a LinkedIn URL
// whose `robots.txt` is a bare `Disallow: /` — because the policy had lapsed
// four hours past a 24-hour TTL, and `unknown` was the only thing left. The
// code was defensible and the outcome was an agent walking into a certain
// refusal. These tests pin the fix: the code stays honest, and `detail` carries
// what is actually known.

const TTL = 86_400

/**
 * The store, minus SQLite.
 *
 * `peek` is a decision about what is known and how old it is, and none of that
 * is a database question. Faking the store keeps this suite runnable on a Node
 * without `node:sqlite`, and lets a test seed a policy that was read thirty
 * hours ago without waiting thirty hours. The real store is exercised at the
 * transport boundary, in the container suite, which is where it belongs.
 */
class FakeStore {
  private readonly rows = new Map<string, CachedRobots>()

  peekRobots(origin: string): CachedRobots | null {
    return this.rows.get(origin) ?? null
  }
  storeRobots(origin: string, entry: CachedRobots): void {
    this.rows.set(origin, entry)
  }
}

function robots(env: Record<string, string> = {}) {
  const config = loadConfig({ PAGEFETCH_TOKEN: "0123456789abcdef0123", ...env } as NodeJS.ProcessEnv)

  const store = new FakeStore()
  // Nothing in a peek may reach the network, so the fetcher is a landmine.
  const forbidden = async (): Promise<FetchResult> => {
    throw new Error("peek() made a network request")
  }
  return { robots: new Robots(config, store as unknown as Store, forbidden), store }
}

/** Store a policy as though it were read `agoMs` in the past. */
function seed(store: FakeStore, origin: string, text: string, agoMs: number): void {
  store.storeRobots(origin, {
    rules: text
      .split("\n")
      .filter((line) => line.startsWith("Disallow:") || line.startsWith("Allow:"))
      .map((line) => ({ allow: line.startsWith("Allow:"), pattern: (line.split(":")[1] ?? "").trim() })),
    fetchedAtMs: Date.now() - agoMs,
  })
}

test("a fresh policy answers plainly, and an allowed path needs no explanation", () => {
  const { robots: r, store } = robots()
  seed(store, "https://example.org", "User-agent: *\nDisallow: /private", 60_000)

  const allowed = r.peek(new URL("https://example.org/awards"))
  assert.equal(allowed.state, "allowed")
  assert.equal(allowed.code, undefined)

  const denied = r.peek(new URL("https://example.org/private/secret"))
  assert.equal(denied.state, "disallowed")
  assert.equal(denied.code, "blocked_robots")
})

test("a lapsed policy is unknown, but says what it last said", () => {
  // The LinkedIn case, to the hour: read 27.8 hours ago, TTL 24, `Disallow: /`.
  const { robots: r, store } = robots()
  seed(store, "https://www.linkedin.com", "User-agent: *\nDisallow: /", 27.8 * 3_600_000)

  const peeked = r.peek(new URL("https://www.linkedin.com/jobs/search?keywords=embedded"))

  // Still `unknown` and still no code — RFC 9309 caps the cache at a day, so a
  // lapsed policy may not decide anything. It may still warn.
  assert.equal(peeked.state, "unknown")
  assert.equal(peeked.code, undefined)
  assert.match(String(peeked.detail), /lapsed/)
  assert.match(String(peeked.detail), /DISALLOWED/, "the strongest fact available must not be buried")
  assert.match(String(peeked.detail), /27\.8 hours ago/, "how stale it is decides how much to trust it")
  assert.match(String(peeked.detail), /blocked_robots/, "say the code a fetch would probably return")
})

test("a lapsed policy that allowed the path says that too, without alarm", () => {
  const { robots: r, store } = robots()
  seed(store, "https://example.org", "User-agent: *\nDisallow: /private", 30 * 3_600_000)

  const peeked = r.peek(new URL("https://example.org/awards"))
  assert.equal(peeked.state, "unknown")
  assert.match(String(peeked.detail), /lapsed/)
  assert.match(String(peeked.detail), /allowed/)
  assert.doesNotMatch(String(peeked.detail), /blocked_robots/, "nothing here predicts a refusal")
})

test("never read is a different fact from lapsed, and says so", () => {
  const { robots: r } = robots()

  const peeked = r.peek(new URL("https://never-asked.example/anything"))
  assert.equal(peeked.state, "unknown")
  assert.equal(peeked.code, undefined)
  assert.match(String(peeked.detail), /no robots\.txt has been read/)
  assert.doesNotMatch(String(peeked.detail), /lapsed/)
})

test("a cached failure within the TTL is what a fetch would return, so report it", () => {
  // `unknown` beside `ok` was the whole defect. A stored challenge is not "no
  // known obstacle" — inside the TTL it is exactly the obstacle fetch_page hits.
  const { robots: r, store } = robots()
  store.storeRobots("https://walled.example", {
    rules: null,
    failure: { code: "blocked_challenge", detail: "an interstitial hid robots.txt" },
    fetchedAtMs: Date.now() - 60_000,
  })

  const peeked = r.peek(new URL("https://walled.example/awards"))
  assert.equal(peeked.state, "unknown", "we still do not know the policy")
  assert.equal(peeked.code, "blocked_challenge", "but we do know what a fetch would say")
  assert.match(String(peeked.detail), /interstitial/)
})

test("a lapsed failure predicts nothing — the next fetch tries again", () => {
  const { robots: r, store } = robots()
  store.storeRobots("https://walled.example", {
    rules: null,
    failure: { code: "blocked_challenge", detail: "an interstitial hid robots.txt" },
    fetchedAtMs: Date.now() - 40 * 3_600_000,
  })

  const peeked = r.peek(new URL("https://walled.example/awards"))
  assert.equal(peeked.state, "unknown")
  assert.equal(peeked.code, undefined, "a lapsed failure is not a current refusal")
  assert.match(String(peeked.detail), /try again/)
})

test("the deny list and the override are decisions, so they never go stale", () => {
  const denied = robots({ PAGEFETCH_ROBOTS_DENY: "asked-us-to-stop.example" }).robots
  const refused = denied.peek(new URL("https://asked-us-to-stop.example/anything"))
  assert.equal(refused.state, "disallowed")
  assert.equal(refused.code, "blocked_robots")
  assert.match(String(refused.detail), /local policy, not by its robots\.txt/)

  const overridden = robots({ PAGEFETCH_ROBOTS_OVERRIDE: "ours.example" }).robots
  const allowed = overridden.peek(new URL("https://ours.example/anything"))
  assert.equal(allowed.state, "allowed")
  assert.equal(allowed.code, undefined)
})

test("the robots TTL cannot be raised past the RFC 9309 ceiling", () => {
  // The tempting fix for a blind probe, and the wrong one: at a weekly cadence
  // a 24-hour TTL means most calls see a lapsed policy, and the cure is to
  // report the lapse rather than to keep acting on it.
  const load = (ttl: number) =>
    loadConfig({
      PAGEFETCH_TOKEN: "0123456789abcdef0123",
      PAGEFETCH_ROBOTS_TTL_SECONDS: String(ttl),
    } as NodeJS.ProcessEnv)

  assert.equal(load(TTL).robotsTtlSeconds, TTL)
  assert.equal(load(3600).robotsTtlSeconds, 3600)
  assert.throws(() => load(TTL + 1), /RFC 9309/)
})
