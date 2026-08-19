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

## Round two, 2026-08-19 — reading the policies we could not read before

Ten targets through the attached browser. The point was never to get past
`robots.txt`; it was that two sites hid theirs behind a challenge, so we could
not tell "refuses crawlers" from "refuses us". Now we can read them, and the
answer differs per site.

### Scholarship aggregators

| Site | Previously | Now | Why |
|---|---|---|---|
| `scholarshipscanada.com` | `blocked_challenge` | **`ok`** | No `User-agent: *` group at all |
| `findaphd.com` | `blocked_challenge` | **`ok`** | robots says `Allow: /` explicitly |
| `scholarship-search.org.uk` | `blocked_challenge` | `blocked_robots` | Genuinely `Disallow: /` |
| `grants-search.turn2us.org.uk/search` | `blocked_robots` | `blocked_robots` | Unchanged |
| `scholartree.ca/scholarships` | `blocked_robots` | `blocked_robots` | Unchanged |

**Two of five, up from zero.** The PRD recorded `findaphd.com` as "403 **and**
robots `Disallow: /`". The 403 was real; the robots claim was wrong — it carries
`Allow: /` and disallows only `/uploads/`, `/common/clickcount.asp` and similar.
Three sites remain refused **by stated policy**, which is an answer and stays one.

### Career sites

| Site | Result |
|---|---|
| `linkedin.com/jobs/search` | `blocked_robots` — a bare `Disallow: /` |
| `totaljobs.com` | `ok` |
| `reed.co.uk` | `ok` — "418 Embedded Engineer Jobs" |
| `jobindex.dk` | `ok` |
| `careers.arm.com/search-jobs` | `ok`, **but see below** |

`VPS_SCRAPER_MCP_SPEC.md` guessed `linkedin-search`, `totaljobs-search` and
`reed-search` were the blocked ones. Only LinkedIn is, and by policy rather than
by challenge — no browser changes that.

### One case where we are on the letter and not the spirit

`careers.arm.com/robots.txt` says `Disallow: /search-jobs/` **with a trailing
slash**. We requested `/search-jobs` **without** one. Under RFC 9309 prefix
matching those are different strings, so the fetch was allowed and the parser is
correct — but the site's intent is not ambiguous.

**Treat ARM's job search as disallowed.** Add `careers.arm.com` to a per-domain
skip rather than leaning on a trailing slash. Being technically permitted is not
the same as being welcome, and this service exists to tell the difference.

### Torn

`torn.com/forums.php` is **allowed** by robots — 347 `Disallow` rules and
`forums.php` is not among them (`forumreport.php` and `forumsearch.php` are).

It fetches, and returns **77 characters**: "Login / Forums". The forum content is
behind authentication, so the page is reachable and empty. Nothing about a
browser changes that; it would need a logged-in session.

Torn publishes an official API at `api.torn.com`, which is the sanctioned route
and does not require pretending a scraper is a person.

## Torn, corrected — it was the fragment, not the login

The earlier reading was wrong. `torn.com/forums.php` returned 77 characters and
I called it a logged-out shell needing authentication. It is a shell, but not
because of authentication — **because the bare URL carries no route**.

Torn's forums are a hash-routed app. Everything meaningful is after the `#`:

```
https://www.torn.com/forums.php#/p=threads&f=46&t=15907925&b=0&a=0&start=85920&to=26282214
```

With the fragment, logged out, we get 7,510 characters of real content: the
board (`Company Recruitment`), the thread title, and every post with author,
player ID, level, post count, karma, last action and timestamp.

The pagination confirms the deep link was honoured rather than merely landing on
the thread — `start=85920` is page 4297 of 5303, and that is the page returned.

### The pattern worth reusing

The fragment never reaches the server, so the app mounts empty and fills in
afterwards. Capturing at `domcontentloaded` gets the shell every time. The fix is
a `wait_for` on the mount point gaining a **child**, not on the mount point
itself — the container is already in the shell:

```json
{ "url": "…forums.php#/p=threads&t=15907925", "wait_for": "#forums-page-wrap > *" }
```

`<mount> > *` generalises to any hash-routed SPA where the container ships in the
initial HTML. This is the failure mode `CONTEXT.md` calls a **fragment route**,
and the one the PRD says no HTTP client can ever reach — demonstrated end to end
against a real site.

Robots still permits it: `forums.php` is not among Torn's 347 disallow rules.

## Why the attached browser worked — the mechanism, measured

Not a guess. Same probe (`navigator` properties on `about:blank`) in all three
modes:

| Mode | `navigator.webdriver` | `plugins` | `languages` |
|---|---|---|---|
| Attached Brave, launched normally | **`false`** | 5 | `en-GB,en-US,en` |
| Playwright-launched, headless | **`true`** | 0 | `en-US` |
| Playwright-launched, headful | **`true`** | 5 | `en-US,en` |

Going headful fixed the plugin count and the language list. It did **not** fix
`navigator.webdriver`, which is exactly why the headful run on a residential IP
with a 45-second budget still failed. That one flag is the difference.

`navigator.webdriver` is `true` because Playwright launches the browser in
automation mode. Attach to a browser launched *normally* and the flag was never
set in the first place.

**This is the whole distinction, and it is worth being precise about.** We did
not patch `navigator.webdriver`, hook it, or lie about it. A stealth plugin makes
an automated browser claim it is not automated. We simply did not automate the
launch — the browser is telling the truth, and the truth happens to be acceptable
to the site. That is why this mode is in scope and a stealth plugin is not.

It also explains the earlier results without any appeal to luck: every mode that
failed had `webdriver: true`, and the one that succeeded had `webdriver: false`.
