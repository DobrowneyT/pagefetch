import test from "node:test"
import assert from "node:assert/strict"
import { call, fetchPage, baseUrl } from "./client.js"

/**
 * These are not unit tests and they are not optional. They run against the real
 * container, because the thing being tested is the container.
 */

test("a private address is rejected before the browser is touched", async () => {
  const outcome = await fetchPage({ url: "http://169.254.169.254/latest/meta-data/" })
  assert.equal(outcome.code, "invalid_url")
  assert.equal(outcome.content, null)
})

test("THE BYPASS THAT MATTERS: a redirect to the metadata endpoint is rejected at the hop", async () => {
  // The submitted URL is entirely legitimate. The rejection has to happen on the
  // hop, when the origin says "now go to 169.254.169.254" — validating only what
  // the caller sent would sail straight past this.
  const outcome = await fetchPage({ url: "http://fixture:3000/redirect-to-metadata" })

  assert.equal(outcome.code, "invalid_url", `expected invalid_url, got ${outcome.code}: ${outcome.detail}`)
  assert.equal(outcome.content, null, "no content may come back from a blocked hop")
  assert.match(String(outcome.detail), /169\.254\.169\.254/)
})

test("a redirect to loopback is rejected at the hop", async () => {
  const outcome = await fetchPage({ url: "http://fixture:3000/redirect-to-loopback" })
  assert.equal(outcome.code, "invalid_url", `expected invalid_url, got ${outcome.code}: ${outcome.detail}`)
  assert.equal(outcome.content, null)
})

test("a benign redirect still works, so the guard is a guard and not a wall", async () => {
  // Without this, a broken redirect implementation would pass the test above for
  // entirely the wrong reason.
  const outcome = await fetchPage({ url: "http://fixture:3000/redirect-to-csr" })
  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.match(outcome.url_final ?? "", /\/csr$/)
})

test("no token is refused", async () => {
  const { httpStatus } = await call("fetch_page", { url: "http://fixture:3000/plain" }, "")
  assert.equal(httpStatus, 401)
})

test("a wrong token is refused", async () => {
  const { httpStatus } = await call("fetch_page", { url: "http://fixture:3000/plain" }, "not-the-real-token-at-all")
  assert.equal(httpStatus, 401)
})

test("a token of a different length is refused without throwing", async () => {
  const { httpStatus } = await call("fetch_page", { url: "http://fixture:3000/plain" }, "short")
  assert.equal(httpStatus, 401)
})

test("the service is not reachable on a non-loopback interface", async () => {
  // The published port is pinned to 127.0.0.1 on the host. Anything else on the
  // network must get nothing at all.
  const external = process.env.PAGEFETCH_EXTERNAL_URL
  if (!external) {
    assert.match(baseUrl, /127\.0\.0\.1|localhost/)
    return
  }

  await assert.rejects(
    () => fetch(`${external}/health`, { signal: AbortSignal.timeout(5000) }),
    "the service answered on a non-loopback address, which it must never do",
  )
})

test("an unimplemented tool says so rather than pretending", async () => {
  const { httpStatus, body } = await call("cache_lookup", { url: "http://fixture:3000/plain" })
  assert.equal(httpStatus, 501)
  assert.match(String(body.error), /not built yet/)
})

test("an unknown tool is a transport error, not a member of the code set", async () => {
  const { httpStatus, body } = await call("run_javascript", { url: "http://fixture:3000/plain" })
  assert.equal(httpStatus, 400)
  assert.equal(body.code, undefined, "a bad tool name must not produce an error-contract code")
})
