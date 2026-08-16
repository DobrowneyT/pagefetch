# Context

The domain language for this repo. The PRD, issues, code, and error codes use
these terms with these meanings. If a term below feels wrong, change it here
first and let the code follow.

## Why the vocabulary matters

"Blocked" is the word everyone reaches for, and it flattens four genuinely
different situations that call for four different responses. A service whose
entire value is telling callers *which* failure they are looking at cannot afford
loose language about failure.

## Failure modes

**Empty shell** — a response that arrived with HTTP 200 and carries no meaningful
content, because the page renders client-side. **The origin is not refusing
anything.** It is serving exactly what it means to serve; a plain HTTP client
simply cannot execute the script that fills it in. This is the failure a browser
fixes most cleanly.

**Fragment route** — a URL whose meaningful part follows `#`. The fragment never
leaves the browser, so the server sees only the base path. **No HTTP client can
ever fetch this**, regardless of headers, and no amount of retrying changes that.

**Challenge** — an interstitial served instead of content, typically by a CDN,
because the client does not look like a browser session. Usually a missing user
agent, no cookie jar, and no JavaScript execution, all of which a stock browser
with a persistent profile resolves by being what it claims to be.

**Robots disallow** — the site's `robots.txt` states that automated clients
should not fetch this path. **This is policy, not a technical obstacle.** It is
an answer, and the correct response is to stop. Distinguishing this from a
challenge is the difference between respecting a stated wish and circumventing
one.

## Service states

**Benched** — a domain temporarily excluded from fetching after it blocked us,
for a cooling-off period. Self-imposed, not imposed by the origin. Protects the
egress IP.

**Disabled** — a domain excluded until a human re-enables it, after repeated
blocks. The escalation of benched, and deliberately requires a person.

**Rate limited** — a request refused by our own limiter because the caller is
asking too fast. Ours, not theirs, and the only failure state where retrying
after the stated delay is correct.

## Fetching

**Plain fetch** — an ordinary HTTP request, made by the consumer, with no browser
involved. The default path, and it stays the default. pagefetch is what a
consumer reaches for **after** this fails.

**Browser fetch** — a fetch performed by pagefetch's Chromium, with a persistent
profile and a per-domain cookie jar.

**Persistent profile** — the browser's on-disk state, kept across requests. A
cold browser on every request looks far more robotic than one that has been to
the site before and kept its cookies, which is why this matters more than any
other single choice.

**Context** — one browser context per domain, so cookie jars stay separated.

## Content and caching

**Cache hit** — content served from the store with **no network traffic at all**.
A response that revalidated against the origin is not a cache hit, whatever the
flag says.

**TTL** — how long cached content stays servable. At a weekly collection cadence
a 7-day TTL means each page is fetched exactly once, which is why the cache is
the primary feature rather than an optimisation.

**`url_final`** — the URL after all redirects. Distinct from the requested URL,
and worth checking: a redirect landing somewhere unexpected is exactly what a
caller needs to notice.

## Consumers

**Consumer** — anything that calls pagefetch. Today: source CLIs in
`ai-scholarship-search`, and Claude Code agents over MCP.

**Unconfigured** — the state where `PAGEFETCH_URL` or `PAGEFETCH_TOKEN` is
missing. **One without the other is unconfigured**, not partially configured. A
consumer in this state must work exactly as it does without pagefetch, which is
what keeps consuming repos forkable.

## Security

**SSRF primitive** — what this service is, structurally: something that fetches
attacker-influenced URLs from inside a trusted network. Naming it plainly is the
point; a browser is *worse* than an HTTP client here because it follows
redirects and executes page-supplied instructions.

**Redirect hop** — each step in a redirect chain. Validation applies to **every
hop**, not just the submitted URL, because a public URL that redirects to a
link-local metadata address is the classic bypass.

**Network isolation** — the absence of a route from this container to the others
on the host. The layer that holds even when the code is wrong, and the single
most important decision in the build.
