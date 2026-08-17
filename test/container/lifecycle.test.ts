import test from "node:test"
import assert from "node:assert/strict"
import { fetchPage, tag, baseUrl } from "./client.js"

const FIXTURE = "http://fixture:3000"

test("a domain's cookie jar is kept across fetches", async () => {
  // The jar is the part of the persistent profile we own, and the reason we look
  // like a returning visitor rather than a brand-new one on every request.
  await fetchPage({ url: `${FIXTURE}/set-cookie?jar-${tag}`, max_age: 0 })

  const shown = await fetchPage({ url: `${FIXTURE}/show-cookie?jar-${tag}`, format: "text", max_age: 0 })
  assert.equal(shown.code, "ok", `expected ok, got ${shown.code}: ${shown.detail}`)
  assert.match(shown.content ?? "", /pfjar=remembered/, "the cookie was not sent back")
})

test("one domain's cookies are absent from another domain", async () => {
  // One context per domain, so jars stay separated.
  const shown = await fetchPage({
    url: `http://norobots-fixture:3000/show-cookie?jar-${tag}`,
    format: "text",
    max_age: 0,
  })

  assert.equal(shown.code, "ok", `expected ok, got ${shown.code}: ${shown.detail}`)
  assert.doesNotMatch(shown.content ?? "", /pfjar/, "a cookie leaked across domains")
})

test("health reports what an operator needs without making a fetch", async () => {
  const response = await fetch(`${baseUrl}/health`)
  const body = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.browser, "up")
  for (const field of ["contexts", "rss_mb", "uptime_seconds", "restarts", "domains"]) {
    assert.ok(field in body, `health should report ${field}`)
  }
  assert.equal(typeof body.rss_mb, "number")
  assert.ok((body.contexts as number) >= 1, "at least one per-domain context should be open")

  const domains = body.domains as { benched: number; disabled: number }
  assert.equal(typeof domains.benched, "number")
  assert.equal(typeof domains.disabled, "number")
})

test("health needs no token, so a container healthcheck does not carry one", async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: {} })
  assert.equal(response.status, 200)
})
