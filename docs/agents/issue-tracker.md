# Issue tracker

Skills that create, read, or triage issues (`to-prd`, `to-issues`, `triage`,
`qa`) read this file to learn where work lives and what labels to apply.

## Where issues live

**GitHub Issues**, in this repo (`DobrowneyT/pagefetch`), via the `gh` CLI.

```bash
gh issue create --title "..." --body-file <path> --label "<label>"
gh issue list --label "ready-for-agent"
gh issue view <n> --json body --jq '.body'
```

Plain `gh issue view <n>` may fail with a Projects-classic GraphQL deprecation
error; the `--json` form above works.

Sub-issues and blocking edges are wired natively where the GitHub API supports
it; the `## Parent` and `## Blocked by` body sections are the fallback.

## PRs as a request surface

**No.** This is personal infrastructure, not an open-source project taking
external contributions. `/triage` reads issues only and leaves pull requests
alone.

## Triage labels

The five canonical roles use their default strings:

| Role | Label | Meaning |
|---|---|---|
| Needs evaluation | `needs-triage` | Maintainer needs to evaluate |
| Waiting on reporter | `needs-info` | Blocked on more information |
| AFK-ready | `ready-for-agent` | Fully specified; an agent can pick it up cold |
| Human-only | `ready-for-human` | Needs human implementation |
| Declined | `wontfix` | Will not be actioned |

### One label with teeth here

Slices touching **network isolation, URL validation, redirect-hop revalidation,
loopback binding, or the bearer token** should be `ready-for-human` unless the
maintainer decides otherwise. Their acceptance criteria require verification
against the real VPS — attempting a connection to a neighbouring container,
confirming the service is not reachable off-loopback — which is not something to
take on trust from a passing test suite.

## Domain docs

**Single-context.** One `CONTEXT.md` at the repo root for the glossary. This is
not a monorepo and does not need a `CONTEXT-MAP.md`.
