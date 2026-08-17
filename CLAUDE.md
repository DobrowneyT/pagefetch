# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`pagefetch` — a self-hosted service that fetches pages plain HTTP cannot, by
driving a real browser in an isolated Docker container on a VPS.

**Status: tracer bullet built.** `fetch_page` over `POST /fetch`, running in the
container, with URL validation, redirect-hop re-validation, loopback binding and
the bearer token in place. All three container security tests pass on the VPS.

**Not built yet, and it matters:** the cache, the rate limiter, benching and
disabling, **`robots.txt` enforcement**, the `/mcp` transport, and the other
three tools. Until robots is enforced, any live target must have its `robots.txt`
checked by hand, and the service should not be left running. The rest is in
`docs/PRD.md` and issue #1.

## Read first

- **`docs/PRD.md`** — the source of truth. `gh issue view 1 --json body --jq '.body'`.
- **`CONTEXT.md`** — the glossary. Empty shell, fragment route, challenge, and
  robots disallow are four different failures needing four different responses;
  benched and disabled are not synonyms. Use these words precisely, in code,
  error codes, commits, and issues.
- **`docs/USING-PAGEFETCH.md`** — the consumer contract. Read it before changing
  anything a caller can observe, because that document is the promise.

## If you are building this

Start with the PRD's suggested first tracer bullet: `fetch_page` over the plain
`/fetch` endpoint, one client-side-rendered page, URL validation and loopback
binding in place, returning `ok` with content and `invalid_url` for a private
address. No cache, no rate limiter, no MCP, no batch. Then run `/to-issues`
against issue #1 to slice the rest.

### Three things to get right before anything else

**Security is not a later slice.** A service fetching arbitrary URLs from inside
a VPS running a database is an SSRF primitive, and a browser is worse than an
HTTP client because it follows redirects and executes what the page tells it to.
Network isolation, URL validation **re-checked on every redirect hop**, and
loopback-only binding come first. The classic bypass is a public URL that 302s to
`169.254.169.254`; test it explicitly, at the hop.

**The cache is the primary feature, not an optimisation.** At a weekly cadence a
7-day TTL means each page is fetched exactly once. Design the cache first and the
fetching second. A "cache hit" that revalidated against the origin is not a cache
hit.

**The error contract is the product.** The codes in the PRD are a closed set, and
adding one is an API change. Consumers make retry decisions from them, and a
wrong code causes an agent either to give up on a reachable page or to hammer a
domain that refused it.

## Hard constraints

Not judgement calls. They keep the shared VPS egress IP in good standing.

- No CAPTCHA solving. No third-party solving services, ever.
- No fingerprint spoofing, no stealth plugins. A stock browser with a persistent
  profile, or nothing.
- No authenticated scraping, no stored site logins.
- No general browser automation — four read-only tools, no click or type.
- `robots.txt` respected by default. An override is a per-domain **config** entry,
  never a request parameter, so no caller can override policy at call time.
- Never behind the public reverse proxy.
- **If a site blocks a stock browser with a persistent profile, the answer is to
  stop, not to escalate.** This service is not a way around a site that has
  decided it does not want automated access.

## Design decisions already settled

- **Two transports, one handler.** `POST /mcp` (JSON-RPC, for agents) and
  `POST /fetch` (plain JSON, for zero-dependency CLIs). One handler so semantics
  cannot diverge, and both run the same behavioural test suite.
- **The `/fetch` shape is already fixed by a shipped consumer** —
  `ai-scholarship-search/.agents/lib/src/fetch.ts`. Honour it, or change it
  deliberately and update that consumer in the same change. Do not leave them
  mismatched.
- **Four tools only:** `fetch_page`, `fetch_pages`, `check_reachable`,
  `cache_lookup`. A fifth needs a reason worth the attack surface and the
  rate-limiting complexity.
- **Rate limits are server-side**, so no caller can exceed them by insistence.

## Testing

Test at the **transport boundary**: send a request to the running service and
assert on the response body and code. Do not reach inside the browser wrapper. A
test that survives swapping Playwright out, and fails if the error contract
changes, is the right test.

Three security tests must run against the **real container**, not mocks:

- A redirect to `169.254.169.254` rejected **at the hop**.
- The other VPS containers unreachable from inside — verified by attempting a
  connection, not by reading the compose file.
- Not reachable on a non-loopback interface.

Rate limiting is tested by exceeding it (25 rapid requests → 20 fetches, 5
`rate_limited`). Cache behaviour is tested by asserting **network silence**, not
by trusting the `from_cache` flag.

Live-fetch tests against third-party sites are deliberate and excluded from the
default suite — running them constantly is the impoliteness this service exists
to avoid.

## Expectations to keep honest

The PRD predicted this unlocks **one** of the five aggregators. **Measured
2026-08-17, it unlocks none of them.** `scholarshipscanada.com` refuses a stock
browser with a persistent profile over its own TLS — probed across three
implementations, all `blocked_challenge`. The other four block by `robots.txt`
policy, which this service respects and will not route around. See issue #10.

That is not the same as the build failing. What it delivers is
client-side-rendered pages (verified end to end), fragment routes, and the
removal of the wasted-discovery loop — a fast honest `blocked_challenge` instead
of a retry spiral. Read issue #10 and the PRD's table before claiming the build
succeeded or failed, and **do not treat the refused aggregator as a problem to
solve.** It is a site that has decided, and the answer is to stop.

## Issues

GitHub Issues via `gh`, in `DobrowneyT/pagefetch`. See `docs/agents/issue-tracker.md`.
Note plain `gh issue view <n>` may fail with a Projects-classic GraphQL
deprecation error; use `gh issue view <n> --json body --jq '.body'`.
