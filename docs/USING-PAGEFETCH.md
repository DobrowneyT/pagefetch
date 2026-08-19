# Using pagefetch

**Read this before writing any code that talks to pagefetch.** It is the complete
contract for consumers. You should not need to read the server's source to use
it correctly, and if you find yourself doing so, that is a bug in this document.

> **Status: built.** All four tools work over both transports. This document is
> the contract the service honours, and it is kept ahead of the code rather than
> behind it — if the two disagree, this document is the bug report.
>
> It remains **optional infrastructure**. Most people running a consuming repo
> will never have it, so [When pagefetch is unavailable](#when-pagefetch-is-unavailable)
> is still a first-class path and not an error path.

---

## The one-paragraph version

pagefetch fetches pages that plain HTTP cannot: client-side-rendered pages,
fragment-route URLs, and origins that refuse non-browser clients. You call it
**only after** a plain fetch has failed, you pass it a URL, and you get back
either content or a **machine-readable code telling you whether to stop**. Most
failure codes mean stop. Honouring that is the entire point — the service exists
to turn slow ambiguous failures into fast honest ones, and an agent that retries
past a `blocked_challenge` has converted the benefit back into the cost.

---

## Deciding whether to call it at all

**Plain HTTP is the default and stays the default.** Do not route ordinary
fetching through pagefetch. It is slower, it is rate limited, it consumes a
shared resource, and it is optional infrastructure that many consumers will not
have configured.

Call it when a plain fetch produced one of:

| Symptom | What it means |
|---|---|
| HTTP 403 with an interstitial body | Origin refuses non-browser clients |
| HTTP 200 whose body carries no meaningful text | Client-side rendered — an empty shell |
| A URL with a `#` fragment route | No HTTP client can ever fetch this |

Do **not** call it for:

- A 404. The page is not there; a browser will not conjure it.
- A 500. The origin is broken; that is not a rendering problem.
- A site whose `robots.txt` disallows the path. pagefetch respects robots and
  will return `blocked_robots`. Calling it wastes a round trip to be told what
  you could have checked yourself.

---

## Configuration

Two environment variables, and **both are required**:

| Variable | Example | Meaning |
|---|---|---|
| `PAGEFETCH_URL` | `http://127.0.0.1:8790` | Base URL of the service |
| `PAGEFETCH_TOKEN` | *(from your password manager)* | Bearer token |

**One without the other is not configuration.** Treat a URL with no token, or a
token with no URL, as unconfigured. This prevents a half-set environment from
producing confusing partial behaviour.

**Unset means disabled.** A consumer with neither variable set must work exactly
as it does without pagefetch, with the plain HTTP path intact and every test
passing. This property is what keeps consuming repos forkable — a forker must
never need a VPS. Assert it directly in your test suite; do not assume it.

The service binds to loopback on the VPS, so reaching it requires a tunnel or a
private overlay network:

```bash
ssh -N -L 8790:127.0.0.1:8790 vps
```

**Never commit the token.** A `.gitignore` entry will not save you from a token
pasted into a committed config file. Keep it in a password manager or a `direnv`
file. It should be read-only, revocable, and single-purpose.

---

## Connecting: two transports

Both transports run through one handler and have identical semantics. Pick based
on what you are.

### If you are a Claude Code agent — MCP

```bash
claude mcp add pagefetch \
  --transport http \
  --url http://127.0.0.1:8790/mcp \
  --header "Authorization: Bearer $PAGEFETCH_TOKEN"
```

Scope it per-project rather than globally, so it appears only where it is wanted.
The four tools then appear natively.

### If you are a CLI or a script — plain JSON

`POST` to `/fetch` with a bearer token. No JSON-RPC envelope, no id correlation,
no `result.content[]` unwrapping. This exists precisely so a zero-dependency CLI
does not have to implement JSON-RPC.

```
POST /fetch
Authorization: Bearer <token>
Content-Type: application/json

{
  "tool": "fetch_page",
  "arguments": {
    "url": "https://example.org/awards",
    "format": "html",
    "wait_for": ".award-card",
    "max_age": 604800
  }
}
```

Response:

```json
{
  "code": "ok",
  "status": 200,
  "url_final": "https://example.org/awards",
  "fetched_at": "2026-08-16T09:12:44.000Z",
  "from_cache": false,
  "content": "<html>…</html>"
}
```

---

## The four tools

### `fetch_page`

| Argument | Required | Default | Meaning |
|---|---|---|---|
| `url` | yes | — | The page to fetch |
| `format` | no | `markdown` | `markdown`, `text`, or `html` |
| `wait_for` | no | — | CSS selector to await before capture |
| `max_age` | no | server TTL | Seconds; `0` forces a refresh |

Returns `code`, `status`, `url_final`, `fetched_at`, `from_cache`, `content`.

**Use `wait_for` whenever you know what the content looks like.** Without it the
service captures on its own heuristic, which may catch a half-rendered page. If
you are parsing award cards, wait for an award card.

**`wait_for` applies to cached answers too.** It means "this content is not
complete until the selector exists", so a cached page that does not contain the
selector is not served — it is refetched. You cannot be handed a stored page
that never had what you asked for. Verifying this costs no network traffic.

#### Fragment routes need a `wait_for`, and probably not the one you think

For a hash-routed page — `example.com/app.php#/thread/123` — the fragment never
reaches the server, so the app mounts **empty** and fills in afterwards. Without a
`wait_for` you will reliably capture the shell.

Waiting on the mount point does not help either: it ships in the initial HTML, so
it already exists. Wait for it to gain a **child**:

```json
{
  "url": "https://www.torn.com/forums.php#/p=threads&f=46&t=15907925",
  "wait_for": "#forums-page-wrap > *"
}
```

`<mount> > *` generalises to any SPA of this shape. Without it that URL returns 77
characters; with it, the full thread. Find the mount point by fetching once
without `wait_for` and looking at the shell's element ids — that first fetch is
cached, so inspecting it costs nothing.

**`fetched_at` on a cache hit is when the page was fetched, not when you read
it.** That is the point of the field: it tells you whether you are reading
something captured now or six days ago.

**`max_age` is in seconds, and `0` forces a refresh.** Omit it to accept the
server's TTL. Asking for the same page in a different `format` does **not**
refetch — formats are derived from what was already stored.

**Check `url_final`.** If a redirect landed somewhere unexpected, this is where
you find out. Do not assume it equals the URL you sent. Two URLs that redirect
to the same place share one cache entry, so a request for one can be served from
a fetch of the other.

### `fetch_pages`

The same, for a list. Pass `urls` (max **50**) plus any of `format`, `wait_for`
and `max_age`, which apply to every URL.

Runs through the rate limiter **sequentially**, not in parallel — that is a
feature, not a limitation. Use it for "fetch these thirty pages" rather than
thirty round trips, and expect it to take real time.

```json
{
  "code": "ok",
  "results": [
    { "url": "https://example.org/a", "code": "ok", "content": "…", "from_cache": false, "…": "…" },
    { "url": "https://example.org/b", "code": "not_found", "content": null, "…": "…" }
  ]
}
```

**Each URL is independent, and the top-level `code` only says the batch ran.**
Read the per-entry codes. A batch of thirty where one domain is benched returns
twenty-nine results and one `domain_benched` — you asked about thirty pages and
you get what is known about all thirty.

### `check_reachable`

A cheap probe: is this fetchable, is it already cached, is the domain benched.

**Call this first when you are about to do a batch.** It is the tool that stops
agents wasting time. Learning that a domain is benched costs one cheap call
instead of thirty rate-limited failures.

```json
{
  "code": "domain_benched",
  "url": "https://example.org/awards",
  "from_cache": false,
  "fetched_at": null,
  "domain": "benched",
  "robots": "allowed",
  "detail": "example.org is benched"
}
```

`code` is what `fetch_page` **would return right now**, as far as can be known
without asking the origin. `from_cache` tells you whether a fetch would be free.

**`robots` may be `unknown`, and that is honest.** This tool makes no network
request whatsoever — that is what makes it cheap — so if we have not already read
that domain's `robots.txt`, we will not go and read it just to answer a probe.
`unknown` means "we would have to ask", not "there is no policy".

### `cache_lookup`

Read-only cache query. No network, no rate limit, free. Use it freely for
re-reads of something you already fetched.

**A miss is a clean miss, not an error**: `code: "ok"` with `from_cache: false`
and `content: null`. Nothing you pass can make it fetch — that is the point of
it being free.

---

## The error contract

**This is the most important section.** Every failure carries a `code` from a
closed set, and each has a defined answer to "should I retry?".

| `code` | Meaning | What you must do |
|---|---|---|
| `ok` | Fetched | Proceed |
| `blocked_challenge` | Interstitial; not reachable this way | **Stop.** Tell the human the page is unreachable. |
| `blocked_robots` | Disallowed by `robots.txt` | **Stop.** This is policy, not a failure. Do not look for a workaround. |
| `rate_limited` | Our own limiter | Retry after `retry_after` seconds |
| `domain_benched` | Backoff after prior blocks, or a domain disabled after repeated ones | **Stop.** Report to the human. |
| `not_found` | 404 | Do not retry |
| `origin_error` | The origin is broken or unreachable — a 5xx, a refused connection, a DNS or TLS failure | Retry **once**, then report it. Not our problem to route around. |
| `timeout` | Render exceeded budget | Retry **once**, with a longer `wait_for` |
| `invalid_url` | Rejected by URL validation | **Stop.** This is a bug in your code or an attack. |

### Rules that are not negotiable

**`blocked_challenge` and `domain_benched` mean stop.** Not "try a different user
agent", not "try again in a minute", not "try a different URL shape". The service
has already used a real browser with a persistent profile — the thing that
resolves most blocks. If it still failed, the site is refusing deliberately and
specifically. Report it to the human and move on.

**`blocked_robots` is an answer, not an obstacle.** The site has stated it does
not want automated access to that path. Do not route around it, do not ask for
an override, do not try a different path to the same content. If you believe the
override is justified, that is a conversation with the operator resulting in a
config entry — never something decided at call time.

**Never retry more than the table says.** A blocked domain that keeps getting
retried is how an egress IP gets permanently listed, and that IP is shared with
unrelated services. The cost of over-retrying is not borne by you.

**Surface the code to the human verbatim.** "Unreachable (`blocked_challenge`)"
is actionable. "Something went wrong fetching the page" is not.

---

## Rate limits

Enforced server-side. You cannot exceed them by insistence, and you should not
try.

| Control | Value | How it is enforced |
|---|---|---|
| Per-domain spacing | ≥ 5 s between requests | By **waiting**. Your call takes longer; it does not fail. |
| Per-domain quota | max 20/hour | By **refusing**, with `retry_after`. |
| Global concurrency | 2 pages at once | By queueing. |
| After a 429/403 | That domain is benched for 1 hour | `domain_benched` |
| 3 blocks in a day | Domain disabled until manually re-enabled | `domain_benched`, with the reason in `detail` |

**`robots.txt` counts against the quota**, because it is a real request to the
origin. The first fetch to a new domain therefore uses two of the twenty.

**`domain_benched` covers both benched and disabled**, because your answer is the
same for each: stop and report it. Which one it is appears in `detail`, where it
is a human's decision rather than something for you to branch on. Only a person
can lift a disable.

Design your caller around these rather than against them. If you need thirty
pages from one domain, that is a `fetch_pages` call that takes a while, not
thirty parallel calls that mostly fail.

---

## When pagefetch is unavailable

**This is the normal case, and it must be a first-class path — not an error
path.** The service is unbuilt today, it is optional infrastructure, and most
people running a consuming repo will never have it.

Your consumer must:

1. **Work fully with both variables unset.** Plain HTTP only, every test passing.
   Assert this explicitly in your suite.
2. **Degrade, not throw, when the service is configured but unreachable.** A
   refused connection or a tunnel that dropped should leave you reporting the
   original plain-HTTP failure, not a crash about pagefetch.
3. **Never make pagefetch a dependency of correctness.** It makes more pages
   reachable. It must never be the reason your code works at all.

### Reference implementation

`ai-scholarship-search/.agents/lib/src/fetch.ts` implements this pattern:

- Plain `fetch()` first, always.
- Block detection distinguishing a challenge from an empty shell.
- Delegation only when **both** variables are set and the plain path was blocked.
- The error contract mapped onto its own `blocked` reasons.
- An unreachable service degrading to the plain result, with `code:
  "pagefetch_unreachable"`.
- An append-only reachability log recording per-host block rates.

Its tests assert the unset-means-disabled property directly. Copy the shape.

**Caveat:** that client has never spoken to a real pagefetch server. It was
written against this contract and exercised against a stub. The first real
integration may need wire-format adjustment; it is isolated to one function.

---

## Recording what you learn

The point of the reachability data is to decide whether running this service is
worth it, and which sites it actually unlocks. If your consumer keeps a
reachability log, record per attempt: the host, the code, which transport was
used, and whether it succeeded.

Do not summarise away the failures. A 100%-blocked host is the most useful row in
the table.

---

## Things people get wrong

- **Routing everything through pagefetch "to be safe".** It is slower, rate
  limited, shared, and usually absent. Plain HTTP first, always.
- **Treating `blocked_robots` as a technical problem.** It is a policy answer.
- **Retrying `blocked_challenge` with a different user agent.** The service
  already used a real browser. You are not going to do better from outside it.
- **Assuming the service exists.** It is optional and currently unbuilt.
- **Committing the token.** Password manager or `direnv`.
- **Parallel calls to beat the rate limiter.** Server-side, and benching is the
  consequence.
- **Ignoring `url_final`.** Redirects land in surprising places.
