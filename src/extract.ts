import TurndownService from "turndown"
import type { Page } from "playwright"

export const FORMATS = ["markdown", "text", "html"] as const
export type Format = (typeof FORMATS)[number]

export function isFormat(value: unknown): value is Format {
  return typeof value === "string" && (FORMATS as readonly string[]).includes(value)
}

/**
 * The two things only the browser can produce.
 *
 * `html` is the rendered DOM and `text` is `innerText`, which has no faithful
 * equivalent over a string — hence both are captured on every fetch and stored.
 * Markdown is derived from the HTML in Node, so asking for a page in a different
 * format than it was cached in costs the origin nothing.
 */
export interface Extracted {
  html: string
  text: string
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
})
// `svg` is a valid thing to strip but is not in turndown's HTML-only tag union.
turndown.remove(["script", "style", "noscript", "iframe", "svg"] as Parameters<typeof turndown.remove>[0])

export async function extract(page: Page): Promise<Extracted> {
  return {
    html: await page.content(),
    text: await page.evaluate(() => document.body?.innerText ?? ""),
  }
}

export function render(extracted: Extracted, format: Format): string {
  if (format === "html") return extracted.html
  if (format === "text") return extracted.text
  return turndown.turndown(extracted.html)
}
