import TurndownService from "turndown"
import type { Page } from "playwright"

export const FORMATS = ["markdown", "text", "html", "raw"] as const
export type Format = (typeof FORMATS)[number]

export function isFormat(value: unknown): value is Format {
  return typeof value === "string" && (FORMATS as readonly string[]).includes(value)
}

/**
 * The two things only the browser can produce, plus the bytes underneath them.
 *
 * `html` is the rendered DOM and `text` is `innerText`, which has no faithful
 * equivalent over a string — hence both are captured on every fetch and stored.
 * Markdown is derived from the HTML in Node, so asking for a page in a different
 * format than it was cached in costs the origin nothing.
 *
 * `raw` is a different thing from all three: the response body as the origin
 * sent it, before Chromium made a document out of it. It is null unless it was
 * asked for, because carrying a second copy of every page is not free.
 */
export interface Extracted {
  html: string
  text: string
  raw?: string | null
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
  // Never derived from the DOM — that is the entire point of asking for it.
  if (format === "raw") return extracted.raw ?? ""
  if (format === "html") return extracted.html
  if (format === "text") return extracted.text
  return turndown.turndown(extracted.html)
}

/**
 * Can a stored row answer a request for this format?
 *
 * `raw` and the three rendered formats are satisfied by different columns, so a
 * page cached as markdown is a miss for `raw` and vice versa. Getting this wrong
 * would serve an empty string as a cache hit, which is the exact failure this
 * format exists to remove.
 */
export function satisfies(stored: Extracted, format: Format): boolean {
  return format === "raw" ? typeof stored.raw === "string" : stored.html !== ""
}
