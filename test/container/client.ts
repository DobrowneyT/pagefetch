import type { FetchResult } from "../../src/codes.js"

const BASE = process.env.PAGEFETCH_URL ?? "http://127.0.0.1:8790"
const TOKEN = process.env.PAGEFETCH_TOKEN ?? ""

export interface RawResponse {
  httpStatus: number
  body: Record<string, unknown>
}

/**
 * Tests talk to the running service over HTTP and assert on the response body
 * and code. Nothing here reaches inside the browser wrapper — a test that
 * survives swapping Playwright out, and fails if the error contract changes, is
 * the right test.
 */
export async function call(tool: string, args: unknown, token: string = TOKEN): Promise<RawResponse> {
  const response = await fetch(`${BASE}/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool, arguments: args }),
  })
  return { httpStatus: response.status, body: (await response.json()) as Record<string, unknown> }
}

export async function fetchPage(args: unknown): Promise<FetchResult> {
  const { body } = await call("fetch_page", args)
  return body as unknown as FetchResult
}

export const baseUrl = BASE
