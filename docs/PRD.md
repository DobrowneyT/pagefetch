# PRD: `pagefetch` — a browser-backed fetch service

## Problem Statement

Agents waste time discovering that a page is unreachable, and they waste it repeatedly.

A skill fetches a URL with plain HTTP, gets a 403 or a page whose body contains no content, retries it, tries a different URL shape, tries a different user agent, and eventually gives up. That loop burns minutes and tokens on something that was never going to work, and it produces no durable knowledge — the next agent, or the same agent next week, starts the same loop from the beginning.

Plain HTTP fails in three distinct ways, and they are worth separating because only one of them is about bot protection:

**The page is rendered client-side.** The HTML that arrives carries no listings; a script fetches them afterwards. Parsing gets an empty shell. This is not a blocking problem at all — the site is perfectly happy to serve the content, it just does so via JavaScript.

**The URL is a fragment route.** Everything after `#` never leaves the browser, so the server sees only the base path. **No HTTP client can ever fetch that page**, with or without bot protection. No amount of header-tweaking fixes it.

**The origin refuses non-browser clients.** Cloudflare and similar return a 403 or an interstitial to anything that does not look like a browser session.

A real browser resolves all three as a side effect of being a real browser. No evasion required, and none used.

The second problem is that the failure is currently silent and unstructured. A 403 and an empty shell and a fragment route all surface to the calling agent as "it didn't work", so the agent cannot tell which of them it is looking at, and therefore cannot tell whether retrying is sensible, whether a different approach would help, or whether it should stop and tell the human. A structured `blocked_challenge` turns a slow, expensive, ambiguous failure into a fast, cheap, honest one.

### What this does not solve, stated up front

**Most sites that block us are blocking by robots policy, not by bot detection, and this service will not unlock them.** Measured against the scholarship aggregators that prompted this work:

> **Measured 2026-08-17. The prediction below was wrong twice, and the answer for
> usable listing data is zero of five.** Full results, and the tooling that
> produced them, are in [`docs/reachability/RESULTS.md`](reachability/RESULTS.md)
> and issue #10. The table is left as written, because a prediction is more
> useful next to its outcome than quietly corrected.
>
> **Superseded 2026-08-19: two of five, not zero.** Attached to a real browser
> (`docs/BYOB.md`), `scholarshipscanada.com` and `findaphd.com` both fetch. The
> challenge was hiding their `robots.txt`, and neither disallows us — the first
> has no `User-agent: *` group at all, the second says `Allow: /`. The row below
> for `findaphd.com` claims a robots `Disallow: /` that does not exist. The other
> three are refused by stated policy and stay refused.

| Site | Predicted | Measured 2026-08-17 |
|---|---|---|
| `scholarshipscanada.com` | Cloudflare challenge — **likely yes** | `blocked_challenge`. Probed across three implementations — the tracer, after challenge-settling (#11), and behind the validating egress proxy with the browser's own TLS (#3). It refuses a stock browser. |
| `findaphd.com` | 403 **and** robots `Disallow: /` | `blocked_challenge` — we never got far enough to read its robots. |
| `scholarship-search.org.uk` | robots `Disallow: /` | `blocked_challenge` — its `robots.txt` is *itself* behind the challenge, so its policy is unknowable. |
| `grants-search.turn2us.org.uk` | robots `Disallow: /` | **Prediction wrong.** Its robots says `Allow: /$` then `Disallow: /`, so under RFC 9309 longest-match the homepage is explicitly allowed and every listing path is not. `/` returns `ok`; `/search` returns `blocked_robots`. |
| `scholartree.ca` | robots disallows `/scholarships` | `blocked_robots`. Prediction correct. |

**Two of the five turned out to hide their `robots.txt` behind a challenge**,
which the design did not anticipate: "check robots before fetching" is circular
when the policy is unreadable. That case now refuses the domain and reports
`blocked_challenge`, because inferring permission from a page we could not read
would resolve every ambiguity in our own favour.

pagefetch respects `robots.txt` by default. A site that has said "do not crawl this" is not a technical obstacle to route around; it is an answer. So the honest expected return on this build is **one** currently-blocked aggregator, plus every future site that turns out to be client-side rendered, plus the elimination of the wasted-discovery loop across every agent and repo. That is a reasonable return, and it is smaller than "unblocks the sites we cannot reach today".

Anyone building this should read that table before starting, so the acceptance criteria are judged against what it can actually deliver.

## Solution

A small, self-hosted service that fetches pages a plain HTTP request cannot, by driving a real browser inside its own Docker container on an existing VPS. Built for the scholarship and job-search skills, usable by any agent on any machine once access is granted.

Four properties define it:

**It is a cache with a browser attached.** The cache is the primary feature, not an optimisation. At a weekly collection cadence a 7-day TTL means each page is fetched exactly once. Design the cache first and the fetching second.

**It has a narrow tool surface.** Four tools, not general browser automation. The official Playwright MCP exposes click, type, navigate, and snapshot — the right tool for interactive agent browsing and the wrong one here. A large surface lets an agent drive the browser somewhere unintended, and it makes per-domain rate limiting nearly impossible because the server no longer knows what constitutes "a request".

**Every failure is machine-readable.** A fixed vocabulary of error codes, each with a documented answer to "should the caller retry?". This is the part that earns its keep.

**It refuses to escalate.** No CAPTCHA solving, no fingerprint spoofing, no stored logins. A stock browser with a persistent profile, or nothing. Where a site still blocks after that, it is blocking deliberately and specifically, and the correct response is to stop.

It exposes two transports over one handler: MCP over JSON-RPC for Claude Code agents connecting via `claude mcp add`, and a plain JSON endpoint for zero-dependency CLIs that should not have to hand-roll a JSON-RPC client.

## User Stories

### Fetching

1. As an agent, I want to fetch a page that returns an empty shell to plain HTTP and get its rendered content, so that client-side rendering stops being a dead end.
2. As an agent, I want to fetch a fragment-route URL and get the content the browser would show, so that pages no HTTP client can reach become reachable.
3. As an agent, I want to fetch a page behind a Cloudflare interstitial and either get the content or a definitive statement that I cannot, so that I stop guessing.
4. As an agent, I want to choose whether content comes back as markdown, plain text, or raw HTML, so that I get the shape my parser wants.
5. As an agent, I want to await a CSS selector before content is captured, so that a slow client-side render is not captured half-finished.
6. As an agent, I want to fetch a list of URLs in one call, so that collecting thirty postings is not thirty round trips.
7. As an agent, I want a batch fetch to run through the rate limiter rather than in parallel, so that a batch cannot become an accidental flood.
8. As an agent, I want to see the final URL after redirects, so that I can tell when a redirect landed somewhere unexpected.

### Knowing before fetching

9. As an agent, I want a cheap reachability probe, so that I learn a page is unreachable in one call instead of a retry spiral.
10. As an agent, I want the probe to tell me whether the page is already cached, so that I know a fetch is free before I ask for it.
11. As an agent, I want the probe to tell me whether the domain is currently benched, so that I do not queue work against a domain that will refuse it.
12. As an agent, I want a read-only cache query that costs nothing and touches no network, so that re-reading a page I already fetched is free.

### The error contract

13. As an agent, I want every failure to carry a machine-readable code rather than a generic error, so that I can decide what to do without parsing prose.
14. As an agent, I want each code to tell me whether retrying is sensible, so that I do not retry something that will never succeed.
15. As an agent, I want `blocked_challenge` to mean stop, so that I report unreachability to the human instead of escalating.
16. As an agent, I want `blocked_robots` to be distinguishable from a technical failure, so that I understand it as policy rather than as something to work around.
17. As an agent, I want `rate_limited` to carry a `retry_after`, so that backing off correctly is unambiguous.

### Caching

18. As an operator, I want a configurable TTL per fetch, so that a weekly collection and a one-off lookup can have different freshness needs.
19. As an agent, I want to force a refresh, so that I can bypass the cache when I know the page changed.
20. As an agent, I want a cache hit to be marked as such, so that I know whether I am reading something fetched now or six days ago.
21. As an agent, I want a cache hit to cost no network traffic at all, so that the cache is a real saving rather than a revalidation.

### Politeness and protecting the IP

22. As an operator, I want per-domain rate limits enforced server-side, so that no agent can exceed them by accident or by insistence.
23. As an operator, I want global concurrency capped, so that the browser cannot starve the other containers on the VPS.
24. As an operator, I want a domain benched after it blocks us, so that we stop hammering something that has refused.
25. As an operator, I want repeated blocks to disable a domain until I manually re-enable it, so that a persistent refusal becomes a human decision.
26. As an operator, I want `robots.txt` respected by default, so that the service is not a way around a site's stated wishes.
27. As an operator, I want any robots override to require a config entry rather than a request parameter, so that no agent can override policy at call time.

### Security

28. As an operator, I want the container to have no network route to the other containers on the VPS, so that a bug in this service cannot reach the database.
29. As an operator, I want private and link-local addresses rejected before navigation, so that the service is not an SSRF primitive.
30. As an operator, I want every redirect hop re-validated, so that a public URL that redirects to a metadata endpoint is caught.
31. As an operator, I want the service bound to loopback only, so that it is reachable solely over an SSH tunnel or a private overlay network.
32. As an operator, I want a bearer token required even on loopback, so that another process on the host cannot use it.
33. As an operator, I want the token rotatable without a rebuild, so that revoking access is cheap.

### Operating it

34. As an operator, I want the browser to restart when memory exceeds a threshold, so that a multi-day leak does not degrade the host.
35. As an operator, I want one browser context per domain, so that cookie jars stay separated.
36. As an operator, I want a persistent browser profile, so that the service looks like a returning visitor rather than a brand-new one on every request.
37. As an operator, I want structured logs of what was fetched and what was blocked, so that I can see patterns without instrumenting the callers.
38. As an operator, I want a health endpoint, so that I can tell whether the browser is alive without making a fetch.

### Consuming it

39. As a Claude Code agent, I want to connect over MCP, so that the tools appear natively.
40. As a zero-dependency CLI, I want a plain JSON endpoint, so that I do not have to hand-roll a JSON-RPC client to use the service.
41. As a consumer, I want both transports to return identical semantics, so that behaviour does not depend on how I connected.
42. As a consumer, I want unambiguous setup documentation in this repo, so that wiring a new caller up is not archaeology.
43. As a forker of a consuming repo, I want the service to be entirely optional, so that a clone with no VPS still works.

### Measuring whether it was worth it

44. As an operator, I want to point the service at a list of candidate sites and get a reachability verdict for each, so that I learn what it actually unlocks.
45. As an operator, I want those results recorded durably, so that the decision to keep running it is made from data.

## Implementation Decisions

### Wire protocol — two surfaces, one handler

- `POST /mcp` — JSON-RPC 2.0, MCP semantics, for agents connecting via `claude mcp add`.
- `POST /fetch` — plain JSON request and response, for zero-dependency CLIs.

Both route into one handler so behaviour cannot diverge. This exists because consumers genuinely differ: a Claude Code agent wants native tools, and a bun CLI with zero runtime dependencies should not have to build JSON-RPC envelopes, correlate ids, and unwrap `result.content[]` by hand.

**The plain endpoint's contract is already fixed by a shipped consumer.** `ai-scholarship-search/.agents/lib/src/fetch.ts` posts:

```json
{ "tool": "fetch_page", "arguments": { "url": "...", "format": "html", "wait_for": "..." } }
```

and expects:

```json
{ "status": 200, "code": "ok", "content": "...", "url_final": "...", "fetched_at": "...", "from_cache": false }
```

That client has never spoken to a real server. Either honour this shape or change it deliberately and update the consumer in the same change — do not leave them mismatched.

**`status` is the origin's HTTP status as a number, and `code` carries the error
contract.** They are not interchangeable: a `blocked_challenge` arrives with
`status: 403`, and collapsing the two would throw away what the site actually
said. An earlier draft of this document showed `status` as a string mirroring
`code`; `docs/USING-PAGEFETCH.md` always had it as a number, and the number is
correct. The consumer's type was corrected in the same change that settled this.

### Tool surface

Four tools. Do not add a fifth without deciding it is worth the attack surface and the rate-limiting complexity.

**`fetch_page`** — `url`, optional `format` (`markdown` default, `text`, `html`), optional `wait_for` CSS selector, optional `max_age` seconds where `0` forces a refresh. Returns `{ status, url_final, fetched_at, from_cache, content, code }`.

**`fetch_pages`** — the same for a list, run through the rate limiter rather than in parallel.

**`check_reachable`** — a cheap probe. Is this fetchable, is it cached, is the domain benched. This is the tool that stops agents wasting time; document it as the one to call first.

**`cache_lookup`** — read-only cache query. No network, no rate limit, free.

### The error contract

Every failure returns a code from this closed set. Adding a code is an API change.

| `code` | Meaning | Retry? |
|---|---|---|
| `ok` | Fetched | — |
| `blocked_challenge` | Cloudflare or similar interstitial | **No.** Not reachable this way. |
| `blocked_robots` | Disallowed by `robots.txt` | **No.** Policy, not a failure. |
| `rate_limited` | Our own limiter | Yes, after `retry_after` |
| `domain_benched` | Backoff after prior blocks | **No.** Report to the human. |
| `not_found` | 404 | No |
| `origin_error` | Origin broken or unreachable — 5xx, refused connection, DNS or TLS failure | Once, then report |
| `timeout` | Render exceeded budget | Once, with a longer `wait_for` |
| `invalid_url` | Rejected by URL validation | **No.** A bug or an attack. |

The codes are the product as much as the content is. An agent seeing `blocked_challenge` should tell the human the page is unreachable and move on, and the consumer documentation must say so explicitly.

### Architecture

Base image `mcr.microsoft.com/playwright:v1.5x-noble` — it ships Chromium with the system libraries already present, which is the tedious part to get right by hand.

One long-lived browser process. One context per domain, so cookie jars stay separated. Pages opened and closed per request. Restart the browser when RSS exceeds a threshold, because Chromium leaks over days.

Set `mem_limit` so a runaway page cannot starve the other containers, and `--disable-dev-shm-usage` or `shm_size: 1gb`, or Chromium will crash on large pages inside Docker.

**A persistent profile directory matters more than anything else here.** A cold browser on every request looks far more robotic than a browser that has been to the site before and kept its cookies. Most "Cloudflare blocked me" cases are a missing user agent, no cookie jar, and no JavaScript execution — a stock browser with a persistent profile fixes all three by simply being what it claims to be.

### Security

**Read this before writing any code.** A service that fetches arbitrary URLs from inside the VPS is an SSRF primitive, and this VPS runs Postgres and several tenant APIs. A browser is *worse* than a plain HTTP client for this, because it follows redirects and executes whatever the fetched page tells it to.

Three independent layers, because any one of them can be wrong:

1. **Network isolation.** Its own Docker network with no route to the dashboard network. This is the layer that holds even if the code is buggy, and it is the single most important decision in the build.
2. **URL validation before navigation.** `http`/`https` only. Reject literal private addresses — `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `.localhost`, `.internal`. **Re-validate on every redirect hop**, not just the submitted URL; a public URL that 302s to `169.254.169.254` is the classic bypass.
3. **Bind to loopback.** `127.0.0.1:8790`, never `0.0.0.0`. Reachable only over SSH tunnel or a private overlay network.

A bearer token is required even on loopback, so that no other process on the host can use the service. Rotate by editing the env file and restarting.

**Do not put this behind the existing public nginx.** It would be one misconfigured `location` block away from an open proxy that anyone on the internet can point at anything.

### Politeness

Enforced server-side, so no agent can exceed the limits by accident or by insistence.

| Control | Value |
|---|---|
| Per-domain rate | ≥ 5 s between requests, max 20 requests/hour |
| Global concurrency | 2 pages at once |
| `robots.txt` | Respected by default; override requires a per-domain config entry, never a request parameter |
| Backoff | On 429/403, bench that domain for 1 hour |
| Repeated blocks | 3 blocks in a day disables the domain until manually re-enabled |

The last two protect the egress IP, which is the real operational risk: **the VPS IP is shared with other outbound traffic, so a ban earned by scraping could take unrelated services down.** Verify whether the other containers egress on the same address before building; if they do, that shared blast radius is the strongest argument for these caps.

A blocked domain that keeps getting retried is precisely how an address gets permanently listed.

## Testing Decisions

**Test at the transport boundary.** Send a request to the running service, assert on the response body and the code. Do not reach inside the browser wrapper. A test that survives swapping Playwright for something else, and fails if the error contract changes, is the right test.

**The security tests are not optional and are not unit tests.** Three of them must run against the real container:

- A URL redirecting to `169.254.169.254` is rejected **at the redirect hop**, not merely at submission. Test this explicitly; it is the bypass that matters.
- From inside the container, the other VPS containers are unreachable. Verify by attempting a connection, not by reading the compose file.
- The service is not reachable on a non-loopback interface.

**Rate limiting is tested by exceeding it.** 25 rapid requests to one domain produce 20 fetches and 5 `rate_limited`. If the limiter is advisory rather than server-side, this test fails, which is the point.

**Cache behaviour is tested by network silence.** A second identical fetch inside the TTL returns `from_cache: true` with **zero** network traffic — assert on the absence of traffic, not merely on the flag, since a flag can be set by code that still made the request.

**Live-fetch tests are deliberate, not part of the default suite.** They depend on third-party sites and must not run on every commit, both because they are flaky and because running them constantly is precisely the impoliteness this service is supposed to avoid.

**Both transports run the same suite.** Every behavioural test executes against `/mcp` and `/fetch`, because the whole point of one handler is that semantics do not diverge.

## Out of Scope

> **Partly superseded, 2026-08-20. `CLAUDE.md`'s "Hard constraints" is the current
> text; where the two differ, that one wins.** Three entries below were revised
> after the reachability work, and this section is left intact rather than
> rewritten because the reasoning is worth keeping. An agent reading only this
> list gave a confidently wrong answer about attached mode, which is what
> prompted the note.

- **CAPTCHA solving.** No third-party solving services, ever. *(Unchanged, absolute.)*
- **Fingerprint spoofing and stealth plugins.** No `puppeteer-extra-plugin-stealth` or equivalent. A stock browser with a persistent profile, or nothing. *(Unchanged, absolute — and now sharper: never patch `navigator.webdriver`.)*
- **Authenticated scraping.** No storing site logins. If a page needs an account, it is out of scope. — **Revised.** The service still stores no credentials and never logs in on anyone's behalf. But **attached mode is the operator's own browser**, so it inherits whatever session that browser already has; a person's own logged-in browser is theirs. See `CLAUDE.md`.
- **Continuous crawling.** This is not a crawler. A few hundred pages a week is the design point. *(Unchanged.)*
- **Bulk or commercial data collection.** *(Unchanged.)*
- **General browser automation.** No click, type, or form submission. Four read-only tools. — **Revised.** Still true of the built tools, but as a **surface-area** decision rather than a prohibition: each is attack surface and a rate-limiting problem. A fifth tool needs a reason worth both.
- **A public endpoint.** Loopback plus tunnel. Never behind the public reverse proxy. *(Unchanged, absolute.)*
- **Being a way around a site that has decided it does not want automated access.** If a site blocks a stock browser with a persistent profile, the answer is to stop. — **Revised.** A challenge refusal is an answer about the *method*, not the site: this rule cost two reachable aggregators, because the challenge was hiding a `robots.txt` that permitted us. Escalating **capability** is in scope; escalating **deception** never is. A `blocked_robots` is still a full stop.

These are not hedges. They are the design constraints that keep the VPS IP in good standing, which is the actual operational risk.

## Further Notes

**On why no evasion is needed.** Most blocks are not sophisticated detection: a missing or obviously scripted user agent, no cookie jar so every request is a brand-new visitor, and no JavaScript so the challenge script never runs. A stock headless Chromium with a persistent profile fixes all three. Where a site still blocks after that, it is blocking deliberately, and the error contract makes stopping the easy path.

**On the cache being the point.** It is tempting to treat caching as an optimisation to add later. At this cadence it is the difference between fetching a page once and fetching it every time an agent re-reads it. Build it first.

**On the honest expected return.** See the table in the problem statement. This unlocks one known aggregator and an unknown number of client-side-rendered sites, and it removes the wasted-discovery loop everywhere. It does not unlock sites that disallow crawling in `robots.txt`, and nothing in this design should be bent to make it do so.

**On open questions worth resolving early.** Whether a thin custom server beats restricting `@playwright/mcp` by config — worth a short spike, since the narrow surface may be achievable with less code to own. Where the cache lives — a Docker volume of content-addressed files is the simple answer; SQLite buys queryability that may not be needed. And whether the other VPS containers share this egress IP, which determines how serious the politeness caps are.

**Suggested first tracer bullet.** The narrowest end-to-end slice that proves the design: `fetch_page` over the plain `/fetch` endpoint, against one known client-side-rendered page, with URL validation and loopback binding in place, returning `ok` with content and `invalid_url` for a private address. No cache, no rate limiter, no MCP transport, no batch. That exercises the container, the browser lifecycle, the security boundary, and the error contract in one demoable path. Slice from there.
