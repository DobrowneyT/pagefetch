# Spec: `pagefetch` — a browser-backed fetch MCP on the VPS

> **⚠️ Historical. Superseded by [`../PRD.md`](../PRD.md) and issue #1.**
>
> The original 2026-08-09 proposal, drafted for `ai-job-search` and later
> vendored into `ai-scholarship-search`. Kept because the reasoning behind
> several settled decisions lives here and nowhere else — §3 on why no evasion
> is needed, §5's security model, and §6's account of the shared egress-IP risk.
> The PRD carries those forward.
>
> **Do not implement from this file.** Two things in it are now wrong:
>
> - **§7 implies an MCP-only surface.** The service exposes **two** transports
>   over one handler — `POST /mcp` for agents and `POST /fetch` for
>   zero-dependency CLIs, the latter's shape already fixed by a shipped consumer
>   in `ai-scholarship-search`.
> - **§8's guess at which sources are blocked has been measured, and it was
>   optimistic.** Four of the five scholarship aggregators block by `robots.txt`
>   policy rather than bot detection, so this service will not unlock them. The
>   table in the PRD's problem statement is the corrected version — and §8's own
>   closing line, "confirm which skills are actually blocked before wiring any of
>   them", is exactly the advice that produced it.
>
> **If you are writing code that calls pagefetch, read
> [`../USING-PAGEFETCH.md`](../USING-PAGEFETCH.md).** That is the consumer
> contract. This is background.

**Status:** superseded proposal, not built
**Author:** drafted with Claude Code, 2026-08-09
**Owner:** Tristan Dobrowney

A small, self-hosted MCP server that fetches pages a plain HTTP request cannot,
by driving a real browser inside its own Docker container. Built for this
repo's job-search skills; usable by any agent on any machine once access is
granted.

---

## 1. Why this exists

The `.agents/skills/*-search` CLIs fetch with plain HTTP and parse the HTML.
That works for most job boards and is the right default — it is fast, has no
dependencies, and costs nothing to run. It fails in three distinct ways, and
they are worth separating because only one of them is about bot protection:

**a. The page is rendered client-side.** The HTML that arrives contains no
listings; a script fetches them afterwards. Parsing gets an empty shell.

**b. The URL is a fragment route.** Torn's forums are the clean example:
`forums.php#/p=threads&f=61&t=16219555`. Everything after `#` never leaves the
browser, so the server sees only `forums.php`. **No HTTP client can ever fetch
that page**, with or without bot protection — this is not a Cloudflare problem
and no amount of header-tweaking fixes it.

**c. The origin refuses non-browser clients.** Cloudflare and similar return a
403 or an interstitial to anything that does not look like a browser session.

A real browser resolves all three as a side effect of being a real browser. No
evasion required, and none used — see §3.

### The second, larger reason

Agents currently **waste time discovering unreachability**. A skill fetches, gets
a 403 or an empty shell, retries, tries a different URL shape, and eventually
gives up — burning minutes and tokens on something that was never going to
work. A shared fetch service that returns a structured
`blocked: cloudflare_challenge` immediately turns that into a one-line answer,
for every agent, across every repo.

---

## 2. Scope

**In scope**

- Weekly (at most) job-posting collection for the skills in this repo.
- One-off retrieval of a specific page an agent cannot otherwise reach —
  documentation, a forum thread, a wiki page.
- Caching, so a page is fetched once and re-read many times.

**Explicitly out of scope**

- ❌ **CAPTCHA solving.** No third-party solving services, ever.
- ❌ **Fingerprint spoofing / stealth plugins.** No `puppeteer-extra-plugin-stealth`
  or equivalent. A stock browser with a persistent profile, or nothing.
- ❌ **Continuous crawling.** This is not a crawler. See the rate limits in §6.
- ❌ **Authenticated scraping.** No storing site logins. If a page needs an
  account, it is out of scope.
- ❌ **Bulk or commercial data collection.**

These are not hedges — they are the design constraints that keep the VPS IP in
good standing, which is the actual operational risk (§6).

---

## 3. Why no evasion is needed

Most "Cloudflare blocked me" cases are not sophisticated detection. They are:

- a missing or obviously scripted `User-Agent`
- no cookie jar, so every request is a brand-new visitor
- no JavaScript execution, so the challenge script never runs

A stock headless Chromium with a **persistent profile directory** fixes all
three by simply being what it claims to be. The persistent profile matters more
than anything else here: a cold browser on every request looks far more robotic
than a browser that has been to the site before and kept its cookies.

Where a site still blocks after that, it is blocking *deliberately and
specifically*. The correct response is to stop, not to escalate — and §7's
error contract makes stopping the easy path.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ VPS                                                     │
│                                                         │
│  ┌───────────────────────┐   ┌───────────────────────┐  │
│  │ network: pagefetch    │   │ network:              │  │
│  │  (no route to below)  │   │  tnl-dashboard_default│  │
│  │                       │   │                       │  │
│  │  ┌─────────────────┐  │   │  postgres             │  │
│  │  │ pagefetch-mcp   │  │   │  api-forge, api-tnl…  │  │
│  │  │  Chromium       │  │   │  nginx                │  │
│  │  │  cache volume   │  │   │                       │  │
│  │  └─────────────────┘  │   │                       │  │
│  └───────────┬───────────┘   └───────────────────────┘  │
│              │ 127.0.0.1:8790 only                      │
└──────────────┼──────────────────────────────────────────┘
               │ SSH tunnel / Tailscale
          your laptop
```

**Container.** Base `mcr.microsoft.com/playwright:v1.5x-noble` — it ships
Chromium with every system library already present, which is the part that is
tedious to get right by hand.

**Isolation.** Its own Docker network with **no route to
`tnl-dashboard_default`**. This is the single most important line in this
document, and §5 explains why.

**Resources.** Chromium needs roughly 1 GB of headroom under load. Set
`mem_limit` so a runaway page cannot starve the dashboard containers, and
`--disable-dev-shm-usage` (or `shm_size: 1gb`) or Chromium will crash on large
pages inside Docker.

**Lifecycle.** One long-lived browser process, one context per domain (so cookie
jars stay separated), pages opened and closed per request. Restart the browser
if RSS exceeds a threshold — Chromium leaks over days.

---

## 5. Security model

> ⚠️ **Read this section before writing any code.** A service that fetches
> arbitrary URLs from inside the VPS is an **SSRF primitive**, and this VPS runs
> Postgres and five tenant APIs. A browser is *worse* than a plain HTTP client
> for this: it follows redirects and executes whatever the fetched page tells it
> to, so a malicious or compromised page can make requests on its behalf.

The same problem was handled in the torn-dashboard revive proxy (`#308`,
`server/src/warRoomRevive.ts` → `isPrivateHost` / `checkReviveTarget`); that
code is worth reading before implementing this, including its honest comment
about what a literal-address check does *not* cover.

Three independent layers, because any one of them can be wrong:

1. **Network isolation.** No route from the `pagefetch` network to the
   dashboard network. This is the layer that holds even if the code is buggy.
2. **URL validation before navigation.** `http`/`https` only. Reject literal
   private addresses (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
   `169.254/16`, `::1`, `fc00::/7`, `.localhost`, `.internal`). Re-validate on
   **every redirect hop**, not just the initial URL — a public URL that 302s to
   `169.254.169.254` is the classic bypass.
3. **Bind to loopback.** `127.0.0.1:8790`, never `0.0.0.0`. Reachable only over
   SSH tunnel or Tailscale.

**Authentication.** A bearer token, even on loopback — it stops any other
process on the VPS from using it. Rotate by editing the env file and restarting.

**Do not put this behind the existing public nginx.** It would be one
misconfigured `location` block away from an open proxy that anyone on the
internet can point at anything.

---

## 6. Politeness and the IP-ban risk

The VPS IP is shared with the dashboard's outbound Torn API calls. **A ban
earned by scraping job boards could take the dashboard down for five factions.**

> Verify this before building: if the dashboard's outbound traffic egresses on
> the same address, that shared blast radius is real and is the strongest
> argument for the hard caps below.

Enforce server-side, so no agent can exceed them by accident or by insistence:

| Control | Value |
|---|---|
| Per-domain rate | ≥ 5 s between requests, max 20 requests/hour |
| Global concurrency | 2 pages at once |
| `robots.txt` | Respected by default; override requires an explicit per-domain allow entry in config, not a request parameter |
| Backoff | On 429/403, that domain is benched for 1 hour |
| Repeated blocks | 3 blocks in a day → domain disabled until manually re-enabled |

The last two are the ones that actually protect the IP. A blocked domain that
keeps getting retried is precisely how an address gets permanently listed.

**The cache is the primary feature, not an optimisation.** At a weekly cadence,
a 7-day TTL means each posting is fetched exactly once. Design the cache first
and the fetching second.

---

## 7. Tool surface

Deliberately narrow. The official `@playwright/mcp` exposes full browser
automation — click, type, navigate, snapshot. That is the right tool for
interactive agent browsing and the wrong one here: it is a large attack surface,
it lets an agent drive the browser somewhere unintended, and it makes per-domain
rate limiting nearly impossible to enforce because the server no longer knows
what constitutes "a request".

Four tools:

### `fetch_page`
```
url: string
format?: "markdown" | "text" | "html"   (default "markdown")
wait_for?: string                        CSS selector to await
max_age?: number                         seconds; 0 forces a refresh
```
Returns `{ status, url_final, fetched_at, from_cache, content }`.

`url_final` matters — if a redirect landed somewhere unexpected, the caller
should be able to see that.

### `fetch_pages`
Same, for a list. Runs them through the rate limiter rather than in parallel.
For "fetch these 30 postings" without 30 round trips.

### `check_reachable`
Cheap HEAD-or-equivalent probe: is this fetchable, is it cached, is the domain
currently benched. **This is the tool that stops agents wasting time** — call it
first, get a definitive answer, skip the retry spiral.

### `cache_lookup`
Read-only cache query. No network, no rate limit. Free.

### The error contract

This is the part that earns its keep. Every failure returns a **machine-readable
reason**, never a generic error:

| code | meaning | should the agent retry? |
|---|---|---|
| `ok` | fetched | — |
| `blocked_challenge` | Cloudflare/interstitial | **No.** Not reachable this way. |
| `blocked_robots` | disallowed by robots.txt | **No.** Policy, not a failure. |
| `rate_limited` | our own limiter | Yes, after `retry_after` |
| `domain_benched` | backoff after prior blocks | **No.** Report to the human. |
| `not_found` | 404 | No |
| `timeout` | render exceeded budget | Once, with a longer `wait_for` |
| `invalid_url` | rejected by §5 validation | **No.** This is a bug or an attack. |

An agent seeing `blocked_challenge` should tell the human the page is
unreachable and move on. Spell this out in the skill docs — the whole point is
to convert a slow failure into a fast, honest one.

---

## 8. Integration with the existing skills

**Do not rewrite the skills.** They work, they are dependency-free, and plain
HTTP should remain the default path. Add a fallback:

```
plain fetch → looks empty or 403? → pagefetch.fetch_page → parse as before
```

Suggested shape, matching the existing `cli/src` layout:

- A shared `cli/src/lib/fetch.ts` helper: try `fetch()`, detect the
  block/empty-shell signatures, fall back to `pagefetch` when configured.
- `PAGEFETCH_URL` and `PAGEFETCH_TOKEN` from the environment. **Absent means
  disabled** — every skill keeps working exactly as it does today on a machine
  with no access to the service. That property is worth protecting: a forker of
  this repo must not need a VPS.
- Only the skills that actually need it (`linkedin-search`, `totaljobs-search`,
  `reed-search` are the likely candidates) opt in.

Confirm which skills are actually blocked before wiring any of them — the list
above is a guess, and there is no point adding a dependency to a skill that has
never failed.

---

## 9. Granting access to Claude Code

Once running:

```bash
ssh -N -L 8790:127.0.0.1:8790 vps    # or Tailscale, no tunnel needed

claude mcp add pagefetch \
  --transport http \
  --url http://127.0.0.1:8790/mcp \
  --header "Authorization: Bearer $PAGEFETCH_TOKEN"
```

Scope it per-project rather than globally, so it appears only where it is
wanted.

**Token handling:** keep it in a password manager or a `direnv` file, not in
this repo — `.gitignore` will not save you from a token pasted into a committed
config. A read-only, revocable, single-purpose token is the whole idea.

---

## 10. Acceptance criteria

Build is done when:

1. `fetch_page` returns real listing content from a site that currently returns
   an empty shell to plain HTTP.
2. A Torn forum **fragment URL** resolves — proving JS execution, not just a
   better `User-Agent`. Use `forums.php#/p=threads&f=61&t=16219555`; the
   revive-chance formula thread is a known-good target with distinctive content.
3. A URL redirecting to `169.254.169.254` is **rejected at the redirect hop**,
   not merely at submission. Test this explicitly; it is the bypass that matters.
4. From inside the container, the dashboard's Postgres and API containers are
   **unreachable**. Verify by attempting a connection, not by reading the
   compose file.
5. 25 rapid requests to one domain produce 20 fetches and 5 `rate_limited` —
   the limiter is server-side and not advisory.
6. A second identical `fetch_page` inside the TTL returns `from_cache: true`
   with **zero** network traffic.
7. A blocked domain returns `blocked_challenge` and, after 3 blocks, benches
   itself.
8. Every existing skill still passes with `PAGEFETCH_URL` unset.

---

## 11. Open questions

- **Playwright MCP vs. a thin custom server?** This spec assumes custom, for the
  reasons in §7. Worth a spike against `@playwright/mcp` first to confirm the
  narrow surface is genuinely worth writing — if its tool surface can be
  restricted adequately by config, that is less code to own.
- **Where does the cache live?** A Docker volume with content-addressed files is
  the simple answer; SQLite buys queryability that may not be needed.
- **Does the dashboard share this egress IP?** Determines how serious §6 is.
- **Which skills are actually blocked today?** Should be measured, not assumed
  (§8).
- **Does this belong in this repo at all?** It is infrastructure that this repo
  merely consumes. A separate `pagefetch` repo, with this repo depending on it
  via config, is probably the cleaner split — the same reasoning that moved the
  Discord bot and mug-bot out of `torn-dashboard`.

---

## 12. Non-goals restated

Worth repeating because scope creep here has real consequences: this is a
**cache with a browser attached**, fetching at most a few hundred pages a week.
It is not a crawler, not a monitoring service, and not a way around a site that
has decided it does not want automated access. If a site blocks it after §3's
stock-browser approach, the answer is to stop.
