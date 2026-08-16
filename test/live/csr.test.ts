import test from "node:test"
import assert from "node:assert/strict"
import { fetchPage } from "../container/client.js"

/**
 * Live fetches against a third-party site. DELIBERATELY EXCLUDED from the
 * default suite, and gated behind PAGEFETCH_LIVE=1.
 *
 * Not because these tests are unimportant — this is the one that proves the
 * premise outside the lab — but because running them on every commit is exactly
 * the impoliteness this service exists to avoid. Run them when you have changed
 * something that could plausibly break real fetching, and not otherwise.
 *
 * Target: quotes.toscrape.com is published as a scraping practice site and
 * serves no robots.txt, so nothing is disallowed. Its /js/ variant renders its
 * content with JavaScript, which is precisely the failure mode this service
 * exists to fix. Robots enforcement is NOT yet implemented — until it is, any
 * target added here must have its robots.txt checked by hand first.
 */

const LIVE = process.env.PAGEFETCH_LIVE === "1"
const TARGET = "https://quotes.toscrape.com/js/"

test("plain HTTP gets an empty shell from a client-side-rendered page", { skip: !LIVE }, async () => {
  // The control. If this ever starts returning quotes, the target stopped being
  // client-side rendered and the test below proves nothing any more.
  const response = await fetch(TARGET)
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.doesNotMatch(body, /class="quote"/, "target is no longer client-side rendered; pick another")
})

test("pagefetch gets the rendered content from the same URL", { skip: !LIVE }, async () => {
  const outcome = await fetchPage({ url: TARGET, format: "text", wait_for: ".quote" })

  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.equal(outcome.status, 200)
  assert.equal(outcome.from_cache, false)
  assert.match(outcome.content ?? "", /Albert Einstein|quotes/i)
  assert.ok((outcome.content ?? "").length > 200, "expected real rendered content, not a shell")
})

test("a real 404 is not_found", { skip: !LIVE }, async () => {
  const outcome = await fetchPage({ url: "https://quotes.toscrape.com/no-such-page-here" })
  assert.equal(outcome.code, "not_found")
})
