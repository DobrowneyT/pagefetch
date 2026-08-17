export interface Config {
  bind: string
  port: number
  token: string
  profileDir: string
  navTimeoutMs: number
  selectorTimeoutMs: number
  /** How long an interstitial gets to clear itself before we call it blocked. */
  challengeBudgetMs: number
  maxConcurrency: number
  /** Spacing between requests to one domain. Enforced by waiting, not refusing. */
  minDomainIntervalSeconds: number
  /** The hourly cap. Enforced by refusing, with `retry_after`. */
  maxRequestsPerDomainHour: number
  /** How long a domain sits out after it blocks us. */
  benchMinutes: number
  /** Blocks in a day before the domain is disabled until a human intervenes. */
  blocksBeforeDisable: number
  /** Restart the browser once its process tree exceeds this. Chromium leaks over days. */
  memoryRestartMb: number
  /** How many per-domain contexts to keep open before evicting the least recently used. */
  maxContexts: number
  cachePath: string
  cacheTtlSeconds: number
  robotsTtlSeconds: number
  /**
   * Hosts whose `robots.txt` is deliberately ignored.
   *
   * A config entry, never a request parameter — no caller may override policy at
   * call time, and every use is logged. Empty by default, and it should stay
   * that way unless a human has decided otherwise for a specific domain.
   */
  robotsOverride: Set<string>
  /**
   * Hostnames exempt from the private-address rejection.
   *
   * This exists so the test suite can point the browser at a fixture container
   * on a private Docker address. It is a CONFIG entry and never a request
   * parameter, for the same reason the robots override is: no caller may relax
   * policy at call time. Empty in production, and the server says so loudly at
   * startup when it is not.
   */
  allowHosts: Set<string>
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required. Copy .env.example to .env and fill it in.`)
  return value
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number, got ${raw}`)
  return parsed
}

function hostSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bind = env.PAGEFETCH_BIND ?? "127.0.0.1"

  // Binding to a non-loopback interface is a security decision, not a typo, so
  // it has to be stated out loud rather than reached by leaving a var unset.
  if (bind !== "127.0.0.1" && bind !== "::1" && env.PAGEFETCH_ALLOW_PUBLIC_BIND !== "i-understand") {
    throw new Error(
      `PAGEFETCH_BIND is "${bind}". This service must bind to loopback — it is an SSRF primitive and ` +
        `must never be reachable from the network. Set PAGEFETCH_ALLOW_PUBLIC_BIND=i-understand only ` +
        `for a container whose published port is already pinned to 127.0.0.1 on the host.`,
    )
  }

  const token = required(env, "PAGEFETCH_TOKEN")
  if (token.length < 16) throw new Error("PAGEFETCH_TOKEN must be at least 16 characters.")
  if (token === "generate-a-random-token-here") throw new Error("PAGEFETCH_TOKEN is still the placeholder from .env.example.")

  return {
    bind,
    port: number(env, "PAGEFETCH_PORT", 8790),
    token,
    profileDir: env.PAGEFETCH_PROFILE_DIR ?? "/data/profile",
    navTimeoutMs: number(env, "PAGEFETCH_NAV_TIMEOUT_MS", 20_000),
    selectorTimeoutMs: number(env, "PAGEFETCH_SELECTOR_TIMEOUT_MS", 10_000),
    challengeBudgetMs: number(env, "PAGEFETCH_CHALLENGE_BUDGET_MS", 15_000),
    maxConcurrency: number(env, "PAGEFETCH_MAX_CONCURRENCY", 2),
    minDomainIntervalSeconds: number(env, "PAGEFETCH_MIN_DOMAIN_INTERVAL_SECONDS", 5),
    maxRequestsPerDomainHour: number(env, "PAGEFETCH_MAX_REQUESTS_PER_DOMAIN_HOUR", 20),
    benchMinutes: number(env, "PAGEFETCH_BENCH_MINUTES", 60),
    blocksBeforeDisable: number(env, "PAGEFETCH_BLOCKS_BEFORE_DISABLE", 3),
    memoryRestartMb: number(env, "PAGEFETCH_MEMORY_RESTART_MB", 1200),
    maxContexts: number(env, "PAGEFETCH_MAX_CONTEXTS", 20),
    cachePath: env.PAGEFETCH_CACHE_PATH ?? "/data/pagefetch.db",
    // A week. At a weekly collection cadence this means each page is fetched
    // exactly once, which is the entire economic argument for the service.
    cacheTtlSeconds: number(env, "PAGEFETCH_CACHE_TTL_SECONDS", 604_800),
    robotsTtlSeconds: number(env, "PAGEFETCH_ROBOTS_TTL_SECONDS", 86_400),
    robotsOverride: hostSet(env.PAGEFETCH_ROBOTS_OVERRIDE),
    allowHosts: hostSet(env.PAGEFETCH_ALLOW_HOSTS),
  }
}
