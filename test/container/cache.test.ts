import test from "node:test"
import assert from "node:assert/strict"
import { fetchPage, tag } from "./client.js"

const FIXTURE = "http://fixture:3000"
const FIXTURE_ADMIN = process.env.FIXTURE_ADMIN_URL ?? "http://127.0.0.1:3100"

async function counts(): Promise<Record<string, number>> {
  const response = await fetch(`${FIXTURE_ADMIN}/__count`)
  return (await response.json()) as Record<string, number>
}

async function resetCounts(): Promise<void> {
  await fetch(`${FIXTURE_ADMIN}/__reset`)
}

/**
 * Cache behaviour is tested by NETWORK SILENCE, not by the flag.
 *
 * A `from_cache: true` can be set by code that still made the request, and a
 * response that revalidated against the origin is not a cache hit whatever it
 * says. So every assertion here counts what the origin actually saw.
 */

test("a second fetch inside the TTL is served from cache with zero network traffic", async () => {
  const url = `${FIXTURE}/plain?cache-silence-${tag}`

  const first = await fetchPage({ url })
  assert.equal(first.code, "ok", `expected ok, got ${first.code}: ${first.detail}`)
  assert.equal(first.from_cache, false, "the first fetch cannot be a hit")

  await resetCounts()

  const second = await fetchPage({ url })
  assert.equal(second.code, "ok")
  assert.equal(second.from_cache, true, "the second fetch should be a hit")
  assert.equal(second.content, first.content)

  const seen = await counts()
  assert.equal(seen[`fixture /plain?cache-silence-${tag}`], undefined, "a cache hit hit the network — that is not a cache hit")
})

test("a hit reports when the page was actually fetched, not when it was read", async () => {
  const url = `${FIXTURE}/plain?cache-time-${tag}`

  const first = await fetchPage({ url })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const second = await fetchPage({ url })

  assert.equal(second.from_cache, true)
  assert.equal(second.fetched_at, first.fetched_at, "a hit must report the original fetch time")
})

test("max_age 0 forces a refresh and the origin sees it", async () => {
  const url = `${FIXTURE}/plain?cache-force-${tag}`

  await fetchPage({ url })
  await resetCounts()

  const forced = await fetchPage({ url, max_age: 0 })
  assert.equal(forced.code, "ok")
  assert.equal(forced.from_cache, false, "max_age 0 must bypass the cache")

  const seen = await counts()
  assert.equal(seen[`fixture /plain?cache-force-${tag}`], 1, "the origin should have been asked exactly once")
})

test("an entry older than the requested max_age is refetched", async () => {
  const url = `${FIXTURE}/plain?cache-age-${tag}`

  await fetchPage({ url })
  await new Promise((resolve) => setTimeout(resolve, 2100))

  // Cached two seconds ago, and the caller will accept nothing older than one.
  const stale = await fetchPage({ url, max_age: 1 })
  assert.equal(stale.from_cache, false, "an entry past the caller's max_age must not be served")

  // ...and the same entry is fine for a caller with a longer tolerance.
  const fresh = await fetchPage({ url, max_age: 600 })
  assert.equal(fresh.from_cache, true)
})

test("asking for a different format does not refetch", async () => {
  // html and text are both captured on every fetch and markdown is derived from
  // the html, so a change of format costs the origin nothing.
  const url = `${FIXTURE}/plain?cache-formats-${tag}`

  const asHtml = await fetchPage({ url, format: "html" })
  assert.equal(asHtml.from_cache, false)
  await resetCounts()

  const asText = await fetchPage({ url, format: "text" })
  const asMarkdown = await fetchPage({ url, format: "markdown" })

  assert.equal(asText.from_cache, true)
  assert.equal(asMarkdown.from_cache, true)
  assert.match(asText.content ?? "", /Plain page/)
  assert.doesNotMatch(asText.content ?? "", /<h1>/)
  assert.match(asMarkdown.content ?? "", /^#+ Plain page/m)

  const seen = await counts()
  assert.equal(seen[`fixture /plain?cache-formats-${tag}`], undefined, "changing format caused a refetch")
})

test("an entry is keyed on where a redirect landed, not what was asked for", async () => {
  // Fetching a URL that redirects stores the page under its FINAL URL, so
  // asking for that destination directly afterwards is free. Note the direction:
  // the alias is learned by following the redirect once, so it is the second
  // request that is free — the cache cannot know in advance where a redirect
  // will land.
  //
  // Its own destination, because /csr is fetched by other files running in
  // parallel and a shared target would make this assertion a race.
  const destination = `?shared-${tag}`

  const viaRedirect = await fetchPage({ url: `${FIXTURE}/redirect-preserving${destination}`, wait_for: ".award-card" })
  assert.equal(viaRedirect.code, "ok", `expected ok, got ${viaRedirect.code}: ${viaRedirect.detail}`)
  assert.match(viaRedirect.url_final ?? "", /\/csr/)
  await resetCounts()

  const direct = await fetchPage({ url: `${FIXTURE}/csr${destination}`, wait_for: ".award-card" })
  assert.equal(direct.from_cache, true, "the destination should already be cached under its final URL")

  const seen = await counts()
  assert.equal(seen[`fixture /csr${destination}`], undefined, "the shared destination was fetched again")
})

test("asking again for the redirecting URL is free the second time", async () => {
  const destination = `?alias-${tag}`

  await fetchPage({ url: `${FIXTURE}/redirect-preserving${destination}`, wait_for: ".award-card" })
  await resetCounts()

  const again = await fetchPage({ url: `${FIXTURE}/redirect-preserving${destination}`, wait_for: ".award-card" })
  assert.equal(again.from_cache, true, "the alias from requested URL to final URL was not recorded")

  const seen = await counts()
  assert.equal(seen[`fixture /redirect-preserving${destination}`], undefined, "the redirect was followed again")
  assert.equal(seen[`fixture /csr${destination}`], undefined, "the destination was fetched again")
})

test("a cached page that satisfies wait_for is still a hit, and still silent", async () => {
  const url = `${FIXTURE}/csr?cache-waitfor-${tag}`

  const first = await fetchPage({ url, wait_for: ".award-card" })
  assert.equal(first.code, "ok", `expected ok, got ${first.code}: ${first.detail}`)
  await resetCounts()

  const second = await fetchPage({ url, wait_for: ".award-card" })
  assert.equal(second.from_cache, true)
  assert.match(second.content ?? "", /Chancellor Scholarship/)

  // Verifying the selector must not reload the page's subresources.
  const seen = await counts()
  assert.equal(seen[`fixture /csr?cache-waitfor-${tag}`], undefined, "verifying wait_for made a request")
})

test("a cached page that does NOT satisfy wait_for is refetched, not served", async () => {
  // Otherwise a caller who asked to wait for award cards could be handed a
  // stored page that never had any, with no way to tell.
  const url = `${FIXTURE}/csr?cache-waitfor-miss-${tag}`

  await fetchPage({ url, wait_for: ".award-card" })
  const outcome = await fetchPage({ url, wait_for: ".never-appears" })

  assert.equal(outcome.code, "timeout", `expected timeout, got ${outcome.code}: ${outcome.detail}`)
  assert.equal(outcome.content, null)
})

test("a blocked_challenge is not cached as content", async () => {
  // A challenge is a state of the domain, not a property of the page. Caching it
  // would quietly turn a transient refusal into a week-long one.
  const first = await fetchPage({ url: `${FIXTURE}/challenge` })
  const second = await fetchPage({ url: `${FIXTURE}/challenge` })

  assert.equal(first.code, "blocked_challenge")
  assert.equal(second.code, "blocked_challenge")
  assert.equal(second.from_cache, false, "a challenge must not be served from cache")
})

test("a negative max_age is rejected rather than silently treated as zero", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/plain`, max_age: -1 })
  assert.equal((outcome as unknown as { error?: string }).error !== undefined, true)
})
