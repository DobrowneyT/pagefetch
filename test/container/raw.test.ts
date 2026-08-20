import test from "node:test"
import assert from "node:assert/strict"
import { fetchPage, tag } from "./client.js"

const FIXTURE = "http://fixture:3000"

/**
 * `format: "raw"` — the response body as the origin sent it.
 *
 * The three rendered formats all go through the DOM, and a sitemap has no useful
 * DOM. Before this existed the service answered `ok` with a 200 and an empty
 * body, which looks exactly like a successful fetch of a blank page and is the
 * one failure mode a consumer cannot detect.
 */

test("a sitemap comes back as XML, and its entries parse", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/sitemap.xml?${tag}`, format: "raw" })

  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.equal(outcome.status, 200)

  const locations = [...(outcome.content ?? "").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
  assert.deepEqual(locations, [`${FIXTURE}/plain`, `${FIXTURE}/csr`, `${FIXTURE}/spa`])
})

test("a body served as a download is still readable as raw", async () => {
  // Chromium aborts the navigation for these, so there is no DOM and no response
  // body to read — the bytes exist only as a download. An origin that serves a
  // sitemap this way is not doing anything unusual.
  const outcome = await fetchPage({ url: `${FIXTURE}/sitemap-download.xml?${tag}`, format: "raw" })

  assert.equal(outcome.code, "ok", `expected ok, got ${outcome.code}: ${outcome.detail}`)
  assert.match(outcome.content ?? "", /<loc>/)
})

test("asking for a download in a rendered format is an error, not an empty page", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/sitemap-download.xml?rendered-${tag}`, format: "markdown" })

  assert.equal(outcome.code, "origin_error", `expected origin_error, got ${outcome.code}: ${outcome.detail}`)
  assert.match(String(outcome.detail), /raw/)
})

test("a 200 with no body at all is never reported as ok", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/empty-200?${tag}`, format: "raw" })

  assert.equal(outcome.code, "origin_error", `expected origin_error, got ${outcome.code}: ${outcome.detail}`)
  assert.match(String(outcome.detail), /empty body/)
})

test("no format ever returns ok with empty content", async () => {
  // The acceptance criterion for the whole slice, asserted across the set rather
  // than one format at a time.
  for (const format of ["markdown", "text", "html", "raw"]) {
    for (const path of ["/sitemap.xml", "/sitemap-download.xml", "/empty-200", "/plain"]) {
      const outcome = await fetchPage({ url: `${FIXTURE}${path}?sweep-${format}-${tag}`, format })
      if (outcome.code !== "ok") continue
      assert.notEqual(
        outcome.content,
        "",
        `${format} of ${path} reported ok with an empty body — silence dressed as success`,
      )
    }
  }
})

test("an ordinary page is unchanged in the other three formats", async () => {
  const url = `${FIXTURE}/plain?formats-${tag}`

  const asHtml = await fetchPage({ url, format: "html" })
  const asText = await fetchPage({ url, format: "text" })
  const asMarkdown = await fetchPage({ url, format: "markdown" })

  assert.match(asHtml.content ?? "", /<h1>Plain page<\/h1>/)
  assert.match(asText.content ?? "", /Plain page/)
  assert.match(asMarkdown.content ?? "", /# Plain page/)
})

test("raw and the rendered formats share one fetch of the same page", async () => {
  // The cache is the primary feature: a page fetched as raw must answer a later
  // markdown request from the store rather than from the origin, and vice versa.
  const url = `${FIXTURE}/plain?both-${tag}`

  const first = await fetchPage({ url, format: "raw" })
  assert.equal(first.code, "ok", `expected ok, got ${first.code}: ${first.detail}`)
  assert.equal(first.from_cache, false)

  const second = await fetchPage({ url, format: "markdown" })
  assert.equal(second.code, "ok", `expected ok, got ${second.code}: ${second.detail}`)
  assert.equal(second.from_cache, true, "a markdown request refetched a page already stored")
  assert.match(second.content ?? "", /# Plain page/)

  const third = await fetchPage({ url, format: "raw" })
  assert.equal(third.from_cache, true, "a raw request refetched a page already stored")
})

test("a page cached only as raw is not served as a rendered format from a stale row", async () => {
  // A download has no DOM. Asking for markdown afterwards must not be answered
  // with an empty string carrying from_cache: true.
  const url = `${FIXTURE}/sitemap-download.xml?downgrade-${tag}`

  const first = await fetchPage({ url, format: "raw" })
  assert.equal(first.code, "ok", `expected ok, got ${first.code}: ${first.detail}`)

  const second = await fetchPage({ url, format: "text" })
  assert.notEqual(
    second.code === "ok" && second.content === "",
    true,
    "a raw-only cache row was served as an empty rendered page",
  )
})

test("an unknown format is refused at the boundary", async () => {
  const outcome = await fetchPage({ url: `${FIXTURE}/plain`, format: "pdf" })
  assert.match(String((outcome as unknown as { error?: string }).error ?? ""), /format must be one of/)
})
