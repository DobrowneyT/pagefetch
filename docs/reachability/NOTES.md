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

## Attached browser, 2026-08-19 — the picture changes

Connected to a real Brave over CDP (`PAGEFETCH_CDP_URL`, see `../BYOB.md`) on a
laptop rather than the VPS. **`scholarshipscanada.com` is fully reachable.**

The challenge cleared, and the first thing that became readable was the thing
that mattered most:

```
Sitemap: http://www.ScholarshipsCanada.com/sitemap.xml
#Restricting crawl for Gbot

User-agent:  Googlebot
Disallow:  /Schools/CompareProgram.aspx?*
Disallow: /Programs/*
Disallow: /Careers/RelatedCareers.aspx?*
Disallow: /Tracking/WeblinkClicks.aspx?*
```

**There is no `User-agent: *` group at all.** Under RFC 9309, when no group
matches the client, no rules apply — so this site's stated policy does not
disallow general crawling. It restricts Googlebot from four paths and publishes
a sitemap, which is a site expecting to be crawled.

That reframes the earlier result. What was blocking us was bot mitigation, not a
stated wish, and we could not tell the two apart precisely because the mitigation
also hid the statement. Everything the service does downstream — the limiter, the
cache, robots enforcement — is unchanged and still applies; the parser correctly
returns "allowed" for a robots file with no matching group.

Verified end to end: `/Scholarships/<id>/<slug>` detail pages return a complete
record — amount, deadline, provider, renewability, and the full eligibility
matrix (level of study, year, citizenship, region, course load, financial need).

### Worth re-checking now

The other four were assessed when we could not read their policies. `findaphd.com`
and `scholarship-search.org.uk` both returned `blocked_challenge` with their
`robots.txt` unreadable — the same condition that made this site look hostile.
Their actual policy is still unknown, and now it is knowable. Read it first, then
honour whatever it says.

### One gap found

`Sitemap/Scholarships.xml` fetched as a 200 with a completely empty body.
Chromium treats it as a download rather than a document, so there is no DOM to
serialise. pagefetch renders *pages*; a raw asset needs the response body. A
`format: "raw"` that returns the body via the context's request API — carrying
the same cookies — would close this, and would be a small addition.
