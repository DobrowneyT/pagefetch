# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`pagefetch` — a self-hosted service that fetches pages plain HTTP cannot, by
driving a real browser in an isolated Docker container on a VPS.

**Status: built.** All four tools, both transports, `robots.txt` enforced, the
cache and politeness caps on SQLite, and the three container security tests
passing against the real VPS. It also runs **attached to a browser you already
have** (`docs/BYOB.md`), which is how the sites behind challenges became
reachable.

`robots.txt` is enforced (#2). A genuine 404 means **allowed** — RFC 9309, absent
means no restrictions — while a challenge that hides robots means refused, and
only "we read it and it says no" is `blocked_robots`.

The cache is on SQLite (#5) — one store, also holding robots policy and domain
state. The politeness caps are enforced server-side (#6): spacing by **waiting**,
the hourly quota by **refusing** with `retry_after`, benching on a 403/429, and
disabling after three blocks in a day. A disabled domain returns `domain_benched`
and only a person can lift it: `docker compose exec pagefetch node dist/src/cli.js
enable <host>`.

All four tools exist and both transports run the same behavioural suite (#7, #8).
The browser is one process with **one context per domain**, each seeded from that
domain's stored `storageState` so cookies survive a restart, and it restarts
itself when its process tree outgrows `PAGEFETCH_MEMORY_RESTART_MB` (#9).

**Still open:** the `origin_error` decision (#4 — a 500 currently returns `ok`)
and the reachability measurement tooling (#10). The rest is in `docs/PRD.md` and
issue #1.

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

`docs/reachability/RESULTS.md` and `NOTES.md` are the source of truth here.
`RESULTS.md` is generated by `npm run reachability`; `NOTES.md` is hand-written
and holds the reasoning.

**Measured 2026-08-19: two of the five aggregators are reachable**, both via an
attached browser (`docs/BYOB.md`). `scholarshipscanada.com` has no
`User-agent: *` group at all and `findaphd.com` says `Allow: /` — a challenge was
hiding both policies, which is why they looked hostile. The remaining three are
refused by `robots.txt`, which is an answer and stays one.

**The mechanism is `navigator.webdriver`,** and it matters for judging what is in
scope. Playwright launches a browser in automation mode and that flag reads
`true`; attaching to a normally-launched browser leaves it `false`, because it was
never set. Headless-vs-headful does not change it. We do not patch it — a stealth
plugin makes an automated browser claim it is not automated, and that stays out of
scope. Not automating the launch is a different thing.

Three capabilities are demonstrated end to end against real sites:
client-side rendering, **fragment routes** (`torn.com/forums.php#/p=threads&…`
returns a full thread that no HTTP client can reach), and reading a `robots.txt`
that a challenge was hiding.

**A `blocked_robots` is still an answer.** Three aggregators and LinkedIn's job
search refuse by stated policy, and no browser changes that. Do not treat those
as problems to solve.

**Note on the constraints below.** The maintainer has said some were scoping
decisions to stop an agent burning time on blocked sites, rather than standing
policy — specifically "stop if a site blocks a stock browser", "no general
browser automation", and "no authenticated scraping". Treat those three as open
questions for the maintainer, not as settled. The rest still hold, and the
`navigator.webdriver` distinction in `docs/reachability/NOTES.md` is the line
that matters: not automating a launch is fine, patching the flag is not.

## Issues

GitHub Issues via `gh`, in `DobrowneyT/pagefetch`. See `docs/agents/issue-tracker.md`.
Note plain `gh issue view <n>` may fail with a Projects-classic GraphQL
deprecation error; use `gh issue view <n> --json body --jq '.body'`.
