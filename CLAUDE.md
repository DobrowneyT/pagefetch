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

`format: "raw"` returns the response body as the origin sent it (#12), which is
how sitemaps and any other non-document are read — the three rendered formats all
go through the DOM, and a sitemap has none. No format ever answers `ok` with an
empty body.

**Still open:** wiring the consumers to the sites now known reachable (#14). The
rest is in `docs/PRD.md` and issue #1.

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

Revised 2026-08-19, after the reachability work. The line they draw is
**capability, not deception**.

### Absolute. Do not weigh these against anything.

- **No CAPTCHA solving.** No third-party solving services, ever.
- **No fingerprint spoofing, no stealth plugins, no user-agent games.** In
  particular, never patch `navigator.webdriver`. A browser that was launched by
  automation and claims it was not is lying, and that is the entire prohibition
  in one sentence.
- **`robots.txt` respected by default, and read as written.** Both the override
  and the deny list are per-host **config** entries, never request parameters, so
  no caller can move policy at call time. A `blocked_robots` is a full stop, not
  a problem to solve.
  **Do not "improve" the matching rules.** RFC 9309 exactly — a trailing slash
  means the subtree and not the bare path. Guessing that a site "can't have meant
  that" over-blocked `careers.arm.com`, whose one-line robots.txt is precise;
  `docs/reachability/NOTES.md` has the full case and the general lesson.
- **Never behind the public reverse proxy.** Loopback plus a tunnel.
- **No continuous crawling.** A few hundred pages a week is the design point, and
  the politeness caps stay server-side so no caller can exceed them by insistence.

### The capability line

Attaching to a browser a person launched normally leaves `navigator.webdriver`
`false` **because it was never set**. That is categorically different from
setting it back to `false`, and it is why attached mode is in scope while a
stealth plugin is not.

**Improving what we genuinely are is in scope. Misrepresenting what we are is
not.** Running headful, attaching instead of launching, keeping a real cookie
jar, waiting longer for a managed challenge to clear — all fine. Claiming to be
something we are not — never.

### Revised, and why

- **A challenge refusal is an answer about the method, not about the site.** The
  old rule said stop as soon as a stock browser is blocked. That rule cost us two
  reachable aggregators: the challenge was *hiding the robots policy*, and behind
  it `scholarshipscanada.com` turns out to have no `User-agent: *` group at all.
  Escalate capability within the line above, then stop.
- **Four read-only tools is a surface-area decision, not a moral one.** No click
  or type today because each is attack surface and a rate-limiting problem — not
  because interaction is forbidden, and not because a human must be in the loop.
  A fifth tool needs a reason worth both costs.
- **Attached mode inherits whatever session the browser already has.** We do not
  store site credentials and never log in on anyone's behalf; a person's own
  logged-in browser is theirs. Two things stay in view before relying on it: a
  logged-in session is usually governed by terms that say considerably more than
  `robots.txt` does, and the consequences of getting it wrong land on a named
  account rather than on an IP address.

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

## Issues

GitHub Issues via `gh`, in `DobrowneyT/pagefetch`. See `docs/agents/issue-tracker.md`.
Note plain `gh issue view <n>` may fail with a Projects-classic GraphQL
deprecation error; use `gh issue view <n> --json body --jq '.body'`.
