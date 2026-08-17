import test from "node:test"
import assert from "node:assert/strict"
import { fetchPage, tag } from "./client.js"

const FIXTURE = "http://fixture:3000"

test("the premise: a client-side-rendered page returns its rendered content", async () => {
  // Plain HTTP gets an empty shell here. This is the whole reason the service
  // exists, so if this fails nothing else matters.
  const outcome = await fetchPage({ url: `${FIXTURE}/csr?premise-${tag}`, format: "html", wait_for: ".award-card" })

  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.equal(outcome.status, 200)
  assert.equal(outcome.from_cache, false)
  assert.match(outcome.content ?? "", /Chancellor Scholarship/)
  assert.match(outcome.content ?? "", /Rutherford Bursary/)
})

test("a fragment route returns what the browser sees, which no HTTP client can reach", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/spa#/awards/42`, format: "text", wait_for: ".route-content" })

  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.match(outcome.content ?? "", /rendered route: \/awards\/42/)
})

test("format defaults to markdown", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/plain` })
  assert.equal(outcome.code, "ok")
  assert.match(outcome.content ?? "", /^#+ Plain page/m)
})

test("format: text returns text and not tags", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/plain`, format: "text" })
  assert.equal(outcome.code, "ok")
  assert.match(outcome.content ?? "", /Plain page/)
  assert.doesNotMatch(outcome.content ?? "", /<h1>/)
})

test("format: html returns the rendered DOM, not the shell that arrived", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/csr`, format: "html", wait_for: ".award-card" })
  assert.equal(outcome.code, "ok")
  assert.match(outcome.content ?? "", /<div class="award-card">/)
})

test("an unmet wait_for is a timeout, not a half-rendered success", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/csr`, wait_for: ".never-appears" })
  assert.equal(outcome.code, "timeout")
  assert.equal(outcome.content, null, "a timeout must not hand back a half-rendered page")
})

test("a navigation that never completes is a timeout", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/slow` })
  assert.equal(outcome.code, "timeout")
})

test("a 404 is not_found", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/missing` })
  assert.equal(outcome.code, "not_found")
  assert.equal(outcome.status, 404)
})

test("an interstitial is blocked_challenge, and we stop rather than escalate", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/challenge` })
  assert.equal(outcome.code, "blocked_challenge")
  assert.equal(outcome.content, null)
})

test("a challenge that clears itself returns the content behind it", async () => {
  // The regression that mattered: we used to judge the interstitial at t=0 and
  // report blocked_challenge for a challenge a real browser walks straight
  // through. No evasion is involved in passing this — the fixture clears itself
  // for anything that runs its script.
  const outcome = await fetchPage({ url: `${FIXTURE}/challenge-clears`, format: "text" })

  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.match(outcome.content ?? "", /Plain page/)
})

test("a cleared challenge reports the final page's status, not the interstitial's 403", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/challenge-clears`, format: "text" })
  assert.equal(outcome.status, 200, "status must come from the page we actually returned")
  assert.match(outcome.url_final ?? "", /\/plain$/)
})

test("a challenge that never clears is still blocked_challenge, within budget", async () => {
  // The other half. Waiting must not become waiting forever, and an interstitial
  // that does not clear is a definitive answer, not a timeout.
  const started = Date.now()
  const outcome = await fetchPage({ url: `${FIXTURE}/challenge` })
  const elapsed = Date.now() - started

  assert.equal(outcome.code, "blocked_challenge")
  assert.equal(outcome.content, null)
  assert.ok(elapsed < 20_000, `gave up after ${elapsed}ms; the budget must be bounded`)
})

test("an interstitial served with a 200 is still blocked_challenge", async () => {
  // Detecting this by status alone would call it a success and hand the caller
  // an interstitial to parse.
  const outcome = await fetchPage({ url: `${FIXTURE}/challenge-200` })
  assert.equal(outcome.code, "blocked_challenge")
})

test("the response carries every field the consumer contract promises", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/plain` })
  for (const field of ["code", "status", "url_final", "fetched_at", "from_cache", "content"]) {
    assert.ok(field in outcome, `missing promised field: ${field}`)
  }
  assert.equal(typeof outcome.status, "number", "status is the origin's HTTP status, as a number")
  assert.doesNotThrow(() => new Date(outcome.fetched_at).toISOString())
})

test("a bad format is rejected rather than silently defaulted", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/plain`, format: "pdf" })
  assert.equal((outcome as unknown as { error: string }).error !== undefined, true)
})
