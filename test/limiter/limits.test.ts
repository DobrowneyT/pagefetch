import test from "node:test"
import assert from "node:assert/strict"
import { fetchPage } from "../container/client.js"

/**
 * The politeness caps, tested by exceeding them.
 *
 * Runs against its own stack (compose.limits.yml) with the real caps — 20
 * requests/hour, 3 blocks to disable — and only the two durations bent that
 * would otherwise make this take an hour.
 *
 * If the limiter were advisory rather than server-side, every test here fails,
 * which is the point.
 */

const FIXTURE_ADMIN = process.env.FIXTURE_ADMIN_URL ?? "http://127.0.0.1:3100"
const BENCH_MS = 3_000

async function counts(): Promise<Record<string, number>> {
  const response = await fetch(`${FIXTURE_ADMIN}/__count`)
  return (await response.json()) as Record<string, number>
}

function originRequests(seen: Record<string, number>, host: string): number {
  return Object.entries(seen)
    .filter(([key]) => key.startsWith(`${host} `))
    .reduce((total, [, n]) => total + n, 0)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("exceeding the hourly cap refuses the excess and the origin never sees it", async () => {
  const host = "ratelimit-fixture"
  const attempts = 25

  const outcomes = await Promise.all(
    Array.from({ length: attempts }, (_, i) => fetchPage({ url: `http://${host}:3000/plain?burst=${i}` })),
  )

  const ok = outcomes.filter((outcome) => outcome.code === "ok").length
  const limited = outcomes.filter((outcome) => outcome.code === "rate_limited").length

  assert.equal(ok + limited, attempts, `unexpected codes: ${JSON.stringify(outcomes.map((o) => o.code))}`)

  // The cap is 20 requests per hour to a domain, and robots.txt is one of them —
  // it is a real request to the origin like any other. So 19 pages get through,
  // 6 are refused, and the ORIGIN sees exactly 20. That last number is the
  // guarantee; the split either side of it is arithmetic.
  const seen = await counts()
  assert.equal(originRequests(seen, host), 20, "the origin saw more than the hourly cap")
  assert.equal(ok, 19)
  assert.equal(limited, 6)
})

test("every rate_limited response carries a usable retry_after", async () => {
  const host = "ratelimit-fixture"
  const outcome = await fetchPage({ url: `http://${host}:3000/plain?after-cap` })

  assert.equal(outcome.code, "rate_limited", "this host should still be over its cap from the previous test")
  assert.equal(typeof outcome.retry_after, "number")
  assert.ok((outcome.retry_after ?? 0) > 0, "retry_after must be a positive number of seconds")
  assert.ok((outcome.retry_after ?? 0) <= 3600, "retry_after cannot exceed the window it is waiting on")
})

test("requests to one domain are spaced out rather than refused", async () => {
  // Spacing is enforced by waiting. Refusing here would make every second
  // request in a batch fail, which is not what a rate is.
  const host = "spacing-fixture"
  const started = Date.now()

  for (let i = 0; i < 3; i += 1) {
    const outcome = await fetchPage({ url: `http://${host}:3000/plain?spaced=${i}` })
    assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  }

  // robots.txt plus three pages, spaced 0.2s apart, is at least 0.6s of waiting.
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 500, `three spaced fetches took only ${elapsed}ms; spacing is not being applied`)
})

test("a domain that blocks us is benched, and the bench costs the origin nothing", async () => {
  const host = "bench-fixture"

  const blocked = await fetchPage({ url: `http://${host}:3000/challenge` })
  assert.equal(blocked.code, "blocked_challenge", `expected blocked_challenge, got ${blocked.code}`)

  const before = originRequests(await counts(), host)

  const benched = await fetchPage({ url: `http://${host}:3000/plain?while-benched` })
  assert.equal(benched.code, "domain_benched", `expected domain_benched, got ${benched.code}: ${benched.detail}`)
  assert.equal(benched.content, null)

  const after = originRequests(await counts(), host)
  assert.equal(after, before, "a benched domain was still contacted")
})

test("a bench expires on its own", async () => {
  const host = "bench-fixture"
  await sleep(BENCH_MS + 500)

  const outcome = await fetchPage({ url: `http://${host}:3000/plain?after-bench` })
  assert.equal(outcome.code, "ok", `expected ok after the bench expired, got ${outcome.code}: ${outcome.detail}`)
})

test("three blocks in a day disables the domain until a human intervenes", async () => {
  const host = "disable-fixture"

  // Each block benches the domain, so the next block has to wait for the bench
  // to lift — which is exactly the behaviour being tested.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const outcome = await fetchPage({ url: `http://${host}:3000/challenge?block=${attempt}` })
    assert.equal(outcome.code, "blocked_challenge", `block ${attempt}: got ${outcome.code}: ${outcome.detail}`)
    await sleep(BENCH_MS + 500)
  }

  // The bench has expired, but the domain must stay refused — that is what
  // separates disabled from benched.
  const outcome = await fetchPage({ url: `http://${host}:3000/plain?after-disable` })
  assert.equal(outcome.code, "domain_benched", `expected domain_benched, got ${outcome.code}`)
  assert.match(String(outcome.detail), /disabled/, "the detail should tell a human it needs re-enabling")
})
