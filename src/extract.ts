import TurndownService from "turndown"
import type { Page } from "playwright"

export const FORMATS = ["markdown", "text", "html"] as const
export type Format = (typeof FORMATS)[number]

export function isFormat(value: unknown): value is Format {
  return typeof value === "string" && (FORMATS as readonly string[]).includes(value)
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
})
// `svg` is a valid thing to strip but is not in turndown's HTML-only tag union.
turndown.remove(["script", "style", "noscript", "iframe", "svg"] as Parameters<typeof turndown.remove>[0])

export async function extract(page: Page, format: Format): Promise<string> {
  if (format === "html") return page.content()
  if (format === "text") return page.evaluate(() => document.body?.innerText ?? "")
  return turndown.turndown(await page.content())
}
