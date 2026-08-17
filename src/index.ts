import { Browser } from "./browser.js"
import { loadConfig } from "./config.js"
import { createPagefetchServer } from "./server.js"

const config = loadConfig()
const browser = new Browser(config)
const server = createPagefetchServer(config, browser)

if (config.allowHosts.size > 0) {
  console.warn(
    `[pagefetch] WARNING: private-address checks are relaxed for ${[...config.allowHosts].join(", ")}. ` +
      `This is a test-harness setting. It must be empty in production.`,
  )
}

if (config.robotsOverride.size > 0) {
  console.warn(
    `[pagefetch] WARNING: robots.txt is being IGNORED for ${[...config.robotsOverride].join(", ")}. ` +
      `Each of those is a deliberate decision to fetch what a site asked us not to. ` +
      `Every use is logged as robots_override_used.`,
  )
}

server.listen(config.port, config.bind, () => {
  console.log(`[pagefetch] listening on ${config.bind}:${config.port}`)
})

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[pagefetch] ${signal}, shutting down`)
    server.close(() => {
      void browser.close().then(() => process.exit(0))
    })
  })
}
