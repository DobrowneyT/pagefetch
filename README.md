# pagefetch

A small, self-hosted service that fetches pages a plain HTTP request cannot, by
driving a real browser inside its own Docker container. Built for the
`ai-scholarship-search` and `ai-job-search` skills; usable by any agent on any
machine once access is granted.

> **Status: specified, not built.** The requirements are in
> [`docs/PRD.md`](docs/PRD.md) and filed as issue #1. No code exists yet.

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

**Most sites that block us do so by `robots.txt` policy, not bot detection, and
this service will not unlock them** — it respects robots by default. Measured
against the aggregators that prompted this work, exactly one of five is a
candidate. The full table is in the PRD's problem statement, and anyone judging
whether this build succeeded should read it first.

## Documentation

| Document | Read it when |
|---|---|
| [`docs/USING-PAGEFETCH.md`](docs/USING-PAGEFETCH.md) | **You are writing code that calls pagefetch.** The complete consumer contract — configuration, both transports, the four tools, the error contract, and what to do when the service is unavailable. Start here. |
| [`docs/PRD.md`](docs/PRD.md) | You are building or extending the service. Problem, solution, 45 user stories, implementation and testing decisions, out-of-scope list, and the first tracer bullet. |
| [`CONTEXT.md`](CONTEXT.md) | Any time. The domain glossary — block, bench, challenge, and shell each have one fixed meaning here. |
| [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) | You are filing or triaging issues. |
| [`CLAUDE.md`](CLAUDE.md) | You are an agent working in this repo. |

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

These are design constraints, not preferences. They keep the VPS IP in good
standing, which is the real operational risk — the address is shared with
unrelated services.

- ❌ No CAPTCHA solving, ever.
- ❌ No fingerprint spoofing or stealth plugins. A stock browser with a
  persistent profile, or nothing.
- ❌ No authenticated scraping. No stored site logins.
- ❌ No continuous crawling. A few hundred pages a week is the design point.
- ❌ No general browser automation. Four read-only tools.
- ❌ Never behind the public reverse proxy. Loopback plus tunnel.
- ❌ Not a way around a site that has decided it does not want automated access.
  **If a site blocks a stock browser with a persistent profile, the answer is to
  stop.**

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
