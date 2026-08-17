/**
 * The operator's console for domain state.
 *
 * Disabling a domain is deliberately a decision a person has to undo — that is
 * what separates it from benching — so there has to be a way for a person to
 * undo it. Run it inside the container, where the store lives:
 *
 *   docker compose exec pagefetch node dist/src/cli.js status
 *   docker compose exec pagefetch node dist/src/cli.js enable example.org
 */
import { loadConfig } from "./config.js"
import { Store } from "./store.js"

function report(store: Store): void {
  const domains = store.listDomains()
  if (domains.length === 0) {
    console.log("No domain has been benched or disabled.")
    return
  }

  const now = Date.now()
  for (const domain of domains) {
    const state = domain.disabled
      ? "DISABLED — needs re-enabling by hand"
      : domain.benchedUntilMs > now
        ? `benched for another ${Math.ceil((domain.benchedUntilMs - now) / 1000)}s`
        : "available"
    console.log(`${domain.host.padEnd(40)} ${state}   (${domain.blocks} blocks recorded)`)
  }
}

const [command, host] = process.argv.slice(2)
const store = new Store(loadConfig())

try {
  if (command === "status") {
    report(store)
  } else if (command === "enable") {
    if (!host) {
      console.error("usage: cli.js enable <host>")
      process.exit(2)
    }
    store.enableDomain(host.toLowerCase())
    console.log(`${host} re-enabled: bench cleared, disable cleared, block history reset.`)
  } else {
    console.error("usage: cli.js status | cli.js enable <host>")
    process.exit(2)
  }
} finally {
  store.close()
}
