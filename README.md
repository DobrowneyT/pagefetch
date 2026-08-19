# pagefetch

A small, self-hosted service that fetches pages a plain HTTP request cannot, by
driving a real browser inside its own Docker container. Built for the
`ai-scholarship-search` and `ai-job-search` skills; usable by any agent on any
machine once access is granted.

> **Status: built.** All four tools, both transports, `robots.txt` enforced, the
> cache on SQLite, the politeness caps enforced server-side, and the security
> boundary proven by test against the real VPS. Every behavioural test runs
> against `/fetch` and `/mcp` alike.
>
> **What it reaches is measured, not assumed.** Attached to a real browser
> (`docs/BYOB.md`), two of the five scholarship aggregators fetch, three are
> refused by `robots.txt`, and three of five job boards return real listings.
> `docs/reachability/` holds the results and the reasoning.

## What it solves

Plain HTTP fails in three distinct ways, and only one of them is about bot
protection:

- **Client-side rendering** — the HTML that arrives carries no content; a script
  fetches it afterwards.
- **Fragment routes** — everything after `#` never leaves the browser, so no HTTP
  client can ever fetch that page.
- **Origins that refuse non-browser clients** — a 403 or an interstitial to
  anything that does not look like a browser session.

A real browser resolves all three as a side effect of being a real browser. No
evasion required, and none used.

The larger problem it solves is **wasted discovery**: agents currently burn
minutes and tokens learning that a page is unreachable, over and over, producing
no durable knowledge. A structured `blocked_challenge` turns that into a one-line
answer for every agent across every repo.

## What it does not solve

**Sites that refuse by `robots.txt` stay refused** — it respects robots by
default, and that is an answer rather than an obstacle. Three of the five
scholarship aggregators and LinkedIn's job search fall in that category.

Measured results and the reasoning behind them live in
[`docs/reachability/`](docs/reachability/). Read those before judging what this
build did or did not deliver — several earlier verdicts turned out to be wrong,
in both directions.

## Documentation

| Document | Read it when |
|---|---|
| [`docs/USING-PAGEFETCH.md`](docs/USING-PAGEFETCH.md) | **You are writing code that calls pagefetch.** The complete consumer contract — configuration, both transports, the four tools, the error contract, and what to do when the service is unavailable. Start here. |
| [`docs/PRD.md`](docs/PRD.md) | You are building or extending the service. Problem, solution, 45 user stories, implementation and testing decisions, out-of-scope list, and the first tracer bullet. |
| [`CONTEXT.md`](CONTEXT.md) | Any time. The domain glossary — block, bench, challenge, and shell each have one fixed meaning here. |
| [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) | You are filing or triaging issues. |
| [`CLAUDE.md`](CLAUDE.md) | You are an agent working in this repo. |
| [`docs/history/original-proposal.md`](docs/history/original-proposal.md) | You want the reasoning behind a settled decision. The original 2026-08-09 proposal, superseded by the PRD. **Background only — do not implement from it.** |

**If you only need to call the service, `docs/USING-PAGEFETCH.md` is the only
document you need.** You should never have to read the server's source to use it
correctly.

## The shape of it

```
┌──────────────────────────────────────────────────────┐
│ VPS                                                  │
│  ┌────────────────────┐   ┌───────────────────────┐  │
│  │ network: pagefetch │   │ network: other        │  │
│  │  (NO route across) │   │  postgres, APIs…      │  │
│  │  ┌──────────────┐  │   │                       │  │
│  │  │ Chromium     │  │   │                       │  │
│  │  │ cache volume │  │   │                       │  │
│  │  └──────────────┘  │   │                       │  │
│  └─────────┬──────────┘   └───────────────────────┘  │
│            │ 127.0.0.1:8790 only                     │
└────────────┼─────────────────────────────────────────┘
             │ SSH tunnel / private overlay
        your machine
```

Two transports over one handler: `POST /mcp` (JSON-RPC, for Claude Code agents)
and `POST /fetch` (plain JSON, for zero-dependency CLIs).

## Non-negotiables

The line is **capability, not deception**: improving what this genuinely is stays
in scope, and misrepresenting what it is never does.

- ❌ No CAPTCHA solving, ever.
- ❌ No fingerprint spoofing or stealth plugins, and **never a patched
  `navigator.webdriver`**. A browser launched by automation that claims it was
  not is lying — that is the whole prohibition.
- ❌ No continuous crawling. A few hundred pages a week is the design point, and
  the politeness caps are server-side so no caller can exceed them.
- ❌ Never behind the public reverse proxy. Loopback plus tunnel.
- ❌ `robots.txt` is not negotiable at call time. The override is a per-domain
  config entry, and a `blocked_robots` is an answer rather than an obstacle.

✅ In scope, because none of it misrepresents anything: running headful,
**attaching to a browser you launched yourself** rather than launching one,
keeping a real cookie jar, and giving a managed challenge time to clear.

Attaching leaves `navigator.webdriver` reading `false` **because it was never
set** — categorically different from setting it back. That distinction is
measured rather than asserted; see [`docs/reachability/NOTES.md`](docs/reachability/NOTES.md).

Two design constraints are about surface area rather than principle, and can be
revisited with a reason: **four read-only tools, no click or type** (each is
attack surface and a rate-limiting problem), and **no stored site logins**
(attached mode inherits whatever session your own browser already has, which is
a different thing from this service holding credentials).

## Security

A service that fetches arbitrary URLs from inside a VPS running a database is an
**SSRF primitive**, and a browser is worse than an HTTP client for it because it
follows redirects and executes what the page tells it to.

Three independent layers, because any one can be wrong: network isolation with
no route to the other containers, URL validation re-checked **on every redirect
hop**, and loopback-only binding behind a bearer token. The PRD's security
section is required reading before writing any code.

## Related repositories

- `ai-scholarship-search` — the first consumer. Its
  `.agents/lib/src/fetch.ts` already implements the client side of this
  contract, written against the spec and exercised against a stub. It has never
  spoken to a real server.
- `ai-job-search` — the original motivation.
