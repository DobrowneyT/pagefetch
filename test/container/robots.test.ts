import test from "node:test"
import assert from "node:assert/strict"
import { call, fetchPage } from "./client.js"

const FIXTURE = "http://fixture:3000"

/** The fixture's bookkeeping surface, published to loopback for the suite only. */
const FIXTURE_ADMIN = process.env.FIXTURE_ADMIN_URL ?? "http://127.0.0.1:3100"

/** Request counts the fixture kept, so we can assert silence rather than trust a flag. */
async function counts(): Promise<Record<string, number>> {
  const response = await fetch(`${FIXTURE_ADMIN}/__count`)
  return (await response.json()) as Record<string, number>
}

async function resetCounts(): Promise<void> {
  await fetch(`${FIXTURE_ADMIN}/__reset`)
}

test("a disallowed path is blocked_robots", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/private/secret` })

  assert.equal(outcome.code, "blocked_robots", `expected blocked_robots, got ${outcome.code}: ${outcome.detail}`)
  assert.equal(outcome.content, null)
})

test("a disallowed path is never fetched from the origin", async () => {
  // The point of checking policy first: a disallowed path must cost the origin
  // nothing beyond the robots.txt we already had to read.
  await resetCounts()
  await fetchPage({ url: `${FIXTURE}/private/secret` })
  const seen = await counts()

  assert.equal(seen["fixture /private/secret"], undefined, "the disallowed path was actually requested")
})

test("an allowed path is unaffected", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/plain` })
  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
})

test("a more specific Allow beats a shorter Disallow", async () => {
  // Disallow: /private  vs  Allow: /private/public — longest match wins, per
  // RFC 9309. Getting this backwards would silently over-block.
  const outcome = await fetchPage({ url: `${FIXTURE}/private/public/ok` })
  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.match(outcome.content ?? "", /Public exception/)
})

test("no robots.txt at all means allowed, not refused", async () => {
  // RFC 9309: an absent robots.txt means no restrictions apply. Reading a 404 as
  // "unreadable, therefore refuse" would lock us out of every site that simply
  // has no robots file.
  const outcome = await fetchPage({ url: "http://norobots-fixture:3000/plain" })
  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
})

test("robots.txt behind a challenge refuses the domain, and says why", async () => {
  // This is what scholarshipscanada.com actually does. We could not learn the
  // policy, so we do not proceed — and the code says challenge rather than
  // robots, because the site never told us its policy.
  const outcome = await fetchPage({ url: "http://challengerobots-fixture:3000/plain" })

  assert.equal(outcome.code, "blocked_challenge", `expected blocked_challenge, got ${outcome.code}`)
  assert.equal(outcome.content, null)
  assert.match(String(outcome.detail), /robots\.txt/)
})

test("robots.txt is read once per domain, not once per fetch", async () => {
  // Warm the policy first, so this asserts the same thing whatever order the
  // suite runs in, then demand total silence on robots.txt afterwards.
  await fetchPage({ url: `${FIXTURE}/plain` })
  await resetCounts()

  await fetchPage({ url: `${FIXTURE}/plain` })
  await fetchPage({ url: `${FIXTURE}/csr`, wait_for: ".award-card" })
  await fetchPage({ url: `${FIXTURE}/spa` })

  const seen = await counts()
  const reads = seen["fixture /robots.txt"] ?? 0
  assert.equal(reads, 0, `robots.txt was re-read ${reads} times across three fetches; the policy must be cached`)
})

test("a per-domain override ignores robots for that host", async () => {
  // The override is a config entry. PAGEFETCH_ROBOTS_OVERRIDE names this host.
  const outcome = await fetchPage({ url: "http://override-fixture:3000/private/secret" })
  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.match(outcome.content ?? "", /Secret/)
})

test("the override does not leak to any other host", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/private/secret` })
  assert.equal(outcome.code, "blocked_robots", "the override leaked to a host it does not name")
})

test("no request parameter can override robots", async () => {
  // Policy is not negotiable at call time. Anything a caller sends that looks
  // like an override must be ignored rather than honoured.
  for (const extra of [
    { ignore_robots: true },
    { robots: false },
    { override_robots: "yes" },
    { obey_robots: false },
  ]) {
    const outcome = await fetchPage({ url: `${FIXTURE}/private/secret`, ...extra })
    assert.equal(outcome.code, "blocked_robots", `a caller relaxed policy with ${JSON.stringify(extra)}`)
  }
})

test("a trailing-slash Disallow does not cover the bare path", async () => {
  // RFC 9309, and careers.arm.com is why it is followed exactly: its whole
  // robots.txt is `Disallow:/search-jobs/`, the paths beneath it are that
  // platform's AJAX endpoints, and every job detail page is left allowed. This
  // briefly matched the bare path and refused a page the site permits.
  const outcome = await fetchPage({ url: "http://trailingslash-fixture:3000/search-jobs" })

  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.match(outcome.content ?? "", /Job search/)
})

test("the subtree the rule actually names is still refused", async () => {
  const outcome = await fetchPage({ url: "http://trailingslash-fixture:3000/search-jobs/results" })
  assert.equal(outcome.code, "blocked_robots", `expected blocked_robots, got ${outcome.code}: ${outcome.detail}`)
})

test("a longer sibling path is unaffected either way", async () => {
  const outcome = await fetchPage({ url: "http://trailingslash-fixture:3000/search-jobs-archive" })
  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
})

test("an explicit Allow on the bare path is honoured", async () => {
  const index = await fetchPage({ url: "http://trailingslash-fixture:3000/docs" })
  assert.equal(index.code, "ok", `expected ok, got ${index.code}: ${index.detail}`)

  const inside = await fetchPage({ url: "http://trailingslash-fixture:3000/docs/internal" })
  assert.equal(inside.code, "blocked_robots", `expected blocked_robots, got ${inside.code}: ${inside.detail}`)
})

test("a host in the deny list is refused whatever its robots.txt permits", async () => {
  // The mirror image of the override, and the deliberate way to refuse a site
  // whose robots.txt does not refuse us — a person's decision, in config, that
  // no caller can reach. PAGEFETCH_ROBOTS_DENY names this host.
  const outcome = await fetchPage({ url: "http://deny-fixture:3000/plain" })

  assert.equal(outcome.code, "blocked_robots", `expected blocked_robots, got ${outcome.code}: ${outcome.detail}`)
  assert.equal(outcome.content, null)
  assert.match(String(outcome.detail), /PAGEFETCH_ROBOTS_DENY/)
})

test("the deny list never reaches the origin", async () => {
  // Local policy must cost the origin nothing at all — not even a robots.txt
  // read, which we would otherwise do first.
  await resetCounts()
  await fetchPage({ url: "http://deny-fixture:3000/plain?silence" })
  const seen = await counts()

  assert.equal(seen["deny-fixture /plain?silence"], undefined, "a denied host was actually requested")
})

test("the deny list does not leak to any other host", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/plain` })
  assert.equal(outcome.code, "ok", "the deny list leaked to a host it does not name")
})

test("check_reachable reports a denied host without asking it", async () => {
  const { body } = await call("check_reachable", { url: "http://deny-fixture:3000/plain" })
  assert.equal(body.robots, "disallowed")
})
