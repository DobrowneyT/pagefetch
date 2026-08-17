import test from "node:test"
import assert from "node:assert/strict"
import { call, fetchPage } from "./client.js"

const FIXTURE = "http://fixture:3000"
const FIXTURE_ADMIN = process.env.FIXTURE_ADMIN_URL ?? "http://127.0.0.1:3100"

async function counts(): Promise<Record<string, number>> {
  const response = await fetch(`${FIXTURE_ADMIN}/__count`)
  return (await response.json()) as Record<string, number>
}

async function resetCounts(): Promise<void> {
  await fetch(`${FIXTURE_ADMIN}/__reset`)
}

// --- fetch_pages ------------------------------------------------------------

test("fetch_pages returns one result per URL, in order", async () => {
  const urls = [`${FIXTURE}/plain?batch=1`, `${FIXTURE}/plain?batch=2`, `${FIXTURE}/missing?batch=3`]
  const { httpStatus, body } = await call("fetch_pages", { urls })

  assert.equal(httpStatus, 200)
  const results = body.results as { url: string; code: string; content: string | null }[]
  assert.equal(results.length, 3)
  assert.deepEqual(
    results.map((entry) => entry.url),
    urls,
  )
  assert.deepEqual(
    results.map((entry) => entry.code),
    ["ok", "ok", "not_found"],
  )
})

test("one failure does not sink the batch", async () => {
  // A batch of thirty where one domain is benched should return twenty-nine
  // results and one refusal, not nothing.
  const { body } = await call("fetch_pages", {
    urls: [`${FIXTURE}/plain?mixed=1`, "http://169.254.169.254/latest/meta-data/", `${FIXTURE}/plain?mixed=2`],
  })

  const results = body.results as { code: string; content: string | null }[]
  assert.deepEqual(
    results.map((entry) => entry.code),
    ["ok", "invalid_url", "ok"],
  )
  assert.equal(results[0]?.content !== null, true, "the healthy entries still carry content")
})

test("fetch_pages honours the shared format", async () => {
  const { body } = await call("fetch_pages", { urls: [`${FIXTURE}/plain?fmt=1`], format: "text" })
  const results = body.results as { content: string | null }[]
  assert.match(results[0]?.content ?? "", /Plain page/)
  assert.doesNotMatch(results[0]?.content ?? "", /<h1>/)
})

test("an empty or oversized batch is rejected", async () => {
  const empty = await call("fetch_pages", { urls: [] })
  assert.equal(empty.httpStatus, 400)

  const huge = await call("fetch_pages", { urls: Array.from({ length: 51 }, (_, i) => `${FIXTURE}/plain?n=${i}`) })
  assert.equal(huge.httpStatus, 400)
  assert.match(String(huge.body.error), /maximum is 50/)
})

// --- check_reachable --------------------------------------------------------

test("check_reachable makes no outbound request at all", async () => {
  // A probe with a network cost is not a probe. This is the tool that is
  // supposed to save thirty rate-limited failures, so it cannot cost one.
  await resetCounts()
  const { body } = await call("check_reachable", { url: `${FIXTURE}/never-fetched-by-probe` })

  assert.equal(body.code, "ok")
  const seen = await counts()
  assert.equal(seen["fixture /never-fetched-by-probe"], undefined, "the probe made a request")
})

test("check_reachable reports whether a fetch would be free", async () => {
  const url = `${FIXTURE}/plain?probe-cached`

  const before = await call("check_reachable", { url })
  assert.equal(before.body.from_cache, false)
  assert.equal(before.body.fetched_at, null)

  await fetchPage({ url })

  const after = await call("check_reachable", { url })
  assert.equal(after.body.from_cache, true, "a cached page should be reported as free")
  assert.equal(typeof after.body.fetched_at, "string")
})

test("check_reachable reports a disallowed path without fetching it", async () => {
  // Warm the policy so the probe has something to answer from.
  await fetchPage({ url: `${FIXTURE}/plain?probe-warm` })
  await resetCounts()

  const { body } = await call("check_reachable", { url: `${FIXTURE}/private/secret` })
  assert.equal(body.code, "blocked_robots")
  assert.equal(body.robots, "disallowed")

  const seen = await counts()
  assert.equal(seen["fixture /private/secret"], undefined, "the probe touched the network")
  assert.equal(seen["fixture /robots.txt"], undefined, "the probe fetched robots.txt")
})

test("check_reachable admits when it does not know the robots policy", async () => {
  // It will not fetch robots.txt to find out, so `unknown` is the honest answer.
  // A host no other test warms, or the policy would already be known.
  const { body } = await call("check_reachable", { url: "http://coldrobots-fixture:3000/anything" })
  assert.equal(body.robots, "unknown")
})

test("check_reachable rejects a private address", async () => {
  const { body } = await call("check_reachable", { url: "http://169.254.169.254/latest/meta-data/" })
  assert.equal(body.code, "invalid_url")
})

// --- cache_lookup -----------------------------------------------------------

test("cache_lookup returns cached content with no network traffic", async () => {
  const url = `${FIXTURE}/plain?lookup-hit`
  await fetchPage({ url })
  await resetCounts()

  const { body } = await call("cache_lookup", { url })
  assert.equal(body.code, "ok")
  assert.equal(body.from_cache, true)
  assert.match(String(body.content), /Plain page/)

  const seen = await counts()
  assert.equal(seen["fixture /plain?lookup-hit"], undefined, "cache_lookup made a request")
})

test("cache_lookup on an uncached URL is a clean miss, not an error", async () => {
  const { httpStatus, body } = await call("cache_lookup", { url: `${FIXTURE}/plain?never-fetched-at-all` })

  assert.equal(httpStatus, 200)
  assert.equal(body.code, "ok")
  assert.equal(body.from_cache, false)
  assert.equal(body.content, null)
})

test("cache_lookup cannot be made to fetch by any argument", async () => {
  // It is documented as free and network-free. Nothing a caller sends may
  // change that, or the promise is worthless.
  await resetCounts()

  for (const extra of [{ max_age: 0 }, { force: true }, { refresh: true }, { wait_for: ".award-card" }]) {
    const { body } = await call("cache_lookup", { url: `${FIXTURE}/plain?lookup-force`, ...extra })
    assert.equal(body.code, "ok")
  }

  const seen = await counts()
  assert.equal(seen["fixture /plain?lookup-force"], undefined, "cache_lookup fetched")
})

test("cache_lookup serves a different format from the same entry", async () => {
  const url = `${FIXTURE}/plain?lookup-format`
  await fetchPage({ url, format: "html" })
  await resetCounts()

  const { body } = await call("cache_lookup", { url, format: "markdown" })
  assert.equal(body.from_cache, true)
  assert.match(String(body.content), /^#+ Plain page/m)

  const seen = await counts()
  assert.equal(seen["fixture /plain?lookup-format"], undefined, "changing format on a lookup caused a fetch")
})
