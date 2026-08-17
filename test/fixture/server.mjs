// A fixture origin for the container suite.
//
// Deliberately dependency-free and un-built so it can run in a bare node image
// with a bind mount. It exists so the default suite is deterministic, offline,
// and sends zero third-party traffic — constant live fetching is precisely the
// impoliteness this service exists to avoid.
import { createServer } from "node:http"

const PORT = Number(process.env.PORT ?? 3000)

/** A page whose content arrives only after JavaScript runs. An empty shell to plain HTTP. */
const CSR_PAGE = `<!doctype html>
<html><head><title>Awards</title></head>
<body>
  <div id="app"></div>
  <script>
    setTimeout(() => {
      document.getElementById("app").innerHTML =
        '<h1>Open awards</h1>' +
        '<div class="award-card"><h2>Chancellor Scholarship</h2><p>Closes 30 September.</p></div>' +
        '<div class="award-card"><h2>Rutherford Bursary</h2><p>Closes 14 October.</p></div>'
    }, 250)
  </script>
</body></html>`

/** A fragment route. The server never sees what follows "#"; only the browser does. */
const SPA_PAGE = `<!doctype html>
<html><head><title>SPA</title></head>
<body>
  <div id="view">no route</div>
  <script>
    const render = () => {
      const route = location.hash.replace("#", "") || "/"
      document.getElementById("view").innerHTML =
        '<div class="route-content">rendered route: ' + route + '</div>'
    }
    addEventListener("hashchange", render)
    render()
  </script>
</body></html>`

/** What a CDN interstitial looks like. No evasion is attempted against it — it is here to be detected. */
const CHALLENGE_PAGE = `<!doctype html>
<html><head><title>Just a moment...</title></head>
<body><div id="challenge-form">Checking your browser before accessing the site.</div></body></html>`

/**
 * A *managed* challenge: an interstitial that clears itself once its script has
 * run, which is what a real browser is supposed to experience. Note the link —
 * the real interstitial has one too, which is why waiting on a bare `a[href]`
 * selector buys no time at all.
 */
const CHALLENGE_CLEARS_PAGE = `<!doctype html>
<html><head><title>Just a moment...</title></head>
<body>
  <div id="challenge-form">Checking your browser before accessing the site.</div>
  <a href="/plain">continue</a>
  <script>setTimeout(() => location.replace("/plain"), 2000)</script>
</body></html>`

const html = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers })
  res.end(body)
}

const routes = {
  "/csr": (res) => html(res, 200, CSR_PAGE),
  "/spa": (res) => html(res, 200, SPA_PAGE),
  "/challenge": (res) => html(res, 403, CHALLENGE_PAGE),
  "/challenge-200": (res) => html(res, 200, CHALLENGE_PAGE),
  "/challenge-clears": (res) => html(res, 403, CHALLENGE_CLEARS_PAGE, { "cf-mitigated": "challenge" }),
  "/missing": (res) => html(res, 404, "<html><body>not here</body></html>"),
  "/plain": (res) => html(res, 200, "<html><body><h1>Plain page</h1><p>Static content.</p></body></html>"),

  // The bypass that matters: a perfectly public URL that redirects into the
  // cloud metadata endpoint. Validation must catch this ON THE HOP.
  "/redirect-to-metadata": (res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" })
    res.end()
  },
  "/redirect-to-loopback": (res) => {
    res.writeHead(302, { location: "http://127.0.0.1:5432/" })
    res.end()
  },
  // A benign redirect, so we can tell "redirects are broken" from "redirects are guarded".
  "/redirect-to-csr": (res) => {
    res.writeHead(302, { location: "/csr" })
    res.end()
  },
  "/slow": (res) => {
    setTimeout(() => html(res, 200, "<html><body>eventually</body></html>"), 60_000)
  },
}

createServer((req, res) => {
  const path = new URL(req.url, "http://fixture").pathname
  const route = routes[path]
  if (route) return route(res)
  html(res, 404, "<html><body>no such fixture route</body></html>")
}).listen(PORT, "0.0.0.0", () => console.log(`fixture listening on ${PORT}`))
