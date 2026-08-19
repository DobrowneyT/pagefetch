# Reachability notes

Hand-written findings that outlive any single run. `RESULTS.md` is generated and
gets overwritten; this file does not.

## Headful, 2026-08-19

`scholarshipscanada.com` re-probed with the browser running **headful** under a
virtual display (`compose.headful.yml`), from a residential IP rather than the
VPS, with the challenge budget raised to 45 s.

**Still `blocked_challenge`.** It waited the full budget; the interstitial never
cleared.

That exhausts the variables that are legitimately ours to change:

| Variable | Ruled out |
|---|---|
| We judged the challenge too early | #11 — settling, then 15 s, then 45 s |
| The connection did not look like a browser's | #3 — validating proxy, browser's own TLS |
| Headless is detectable | this run — headful under Xvfb |
| The shared VPS egress IP is poorly regarded | this run — residential IP |

A stock browser with a persistent profile is refused. That is the condition the
repo names as the point to stop, and it is the answer.

## What is deliberately not tried

A residential proxy pool, a fingerprint patch, a CAPTCHA service, or driving a
human's already-authenticated browser session. Each would probably work. Each is
out of scope by design, not by oversight — see the non-negotiables in
`README.md`. A site that refuses a stock browser has decided, and routing around
that decision is the thing this service exists **not** to be.

## Worth knowing about turn2us

`grants-search.turn2us.org.uk/robots.txt` explicitly allows `/sitemap.xml`. That
is the site stating how it wants to be crawled, and reading it is permitted.
It does **not** unlock the listings: every path the sitemap points at is under
`Disallow: /`, so the sitemap tells us what exists and policy still says we may
not fetch it. Useful to know, not a way in.
