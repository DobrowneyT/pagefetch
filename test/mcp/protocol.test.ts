import test from "node:test"
import assert from "node:assert/strict"
import { baseUrl, rpc, rpcNotify } from "../container/client.js"

/**
 * Protocol-level behaviour that only exists on `/mcp`.
 *
 * Everything about what a fetch *does* is covered by the shared behavioural
 * suite, which runs against both transports. This file is only about the
 * envelope.
 */

test("initialize returns capabilities and echoes the protocol version", async () => {
  const response = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  })
  const body = (await response.json()) as { result?: Record<string, unknown> }

  assert.equal(response.status, 200)
  assert.equal(body.result?.protocolVersion, "2025-06-18")
  assert.deepEqual(body.result?.capabilities, { tools: {} })
  assert.equal((body.result?.serverInfo as { name: string }).name, "pagefetch")
})

test("tools/list offers exactly the four tools", async () => {
  // A fifth tool needs a reason worth the attack surface and the rate-limiting
  // complexity. This test is where that conversation starts.
  const response = await rpc("tools/list")
  const body = (await response.json()) as { result?: { tools?: { name: string; inputSchema: unknown }[] } }
  const tools = body.result?.tools ?? []

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["cache_lookup", "check_reachable", "fetch_page", "fetch_pages"],
  )
  for (const tool of tools) {
    assert.ok(tool.inputSchema, `${tool.name} must publish an input schema`)
  }
})

test("a notification gets no response body", async () => {
  // `notifications/initialized` is what Claude Code sends after the handshake.
  // Replying to it is a protocol violation.
  const response = await rpcNotify("notifications/initialized")

  assert.equal(response.status, 202)
  assert.equal((await response.text()).length, 0)
})

test("an error-contract code is a RESULT, not a JSON-RPC error", async () => {
  // This is the distinction that keeps the two transports identical. A
  // blocked_challenge is a successful call reporting a refusal.
  const response = await rpc("tools/call", {
    name: "fetch_page",
    arguments: { url: "http://fixture:3000/challenge" },
  })
  const body = (await response.json()) as {
    result?: { content?: { text: string }[]; isError?: boolean }
    error?: unknown
  }

  assert.equal(body.error, undefined, "a contract code must not surface as a JSON-RPC error")
  assert.notEqual(body.result?.isError, true)

  const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as { code?: string }
  assert.equal(payload.code, "blocked_challenge")
})

test("a malformed tool call is a JSON-RPC error carrying no contract code", async () => {
  const response = await rpc("tools/call", { name: "fetch_page", arguments: {} })
  const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string } }

  assert.equal(body.result, undefined)
  assert.equal(body.error?.code, -32602, "bad arguments are invalid params")
  assert.match(String(body.error?.message), /url is required/)
})

test("an unknown tool is a method-not-found error", async () => {
  const response = await rpc("tools/call", { name: "run_javascript", arguments: { url: "http://fixture:3000/plain" } })
  const body = (await response.json()) as { error?: { code: number } }

  assert.equal(body.error?.code, -32601)
})

test("an unknown method is rejected", async () => {
  const response = await rpc("resources/list")
  const body = (await response.json()) as { error?: { code: number } }

  assert.equal(body.error?.code, -32601)
})

test("JSON-RPC batching is refused rather than half-supported", async () => {
  const response = await fetch(`${process.env.PAGEFETCH_URL ?? "http://127.0.0.1:8790"}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.PAGEFETCH_TOKEN}` },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
  })
  const body = (await response.json()) as { error?: { code: number } }

  assert.equal(body.error?.code, -32600)
})

test("/mcp requires the bearer token like everything else", async () => {
  const response = await rpc("tools/list", undefined, "not-the-real-token-at-all")
  assert.equal(response.status, 401)
})

test("the id is echoed back so a client can correlate", async () => {
  const response = await rpc("ping")
  const body = (await response.json()) as { id?: unknown; jsonrpc?: string }

  assert.equal(body.jsonrpc, "2.0")
  assert.equal(typeof body.id, "number")
})

test("GET /mcp is 405, not 404", async () => {
  // The Streamable HTTP transport lets a client open a server-to-client SSE
  // stream with GET. We do not offer one, and the specification says a server
  // that does not MUST answer 405. A 404 reads as "no such endpoint" and can
  // sink the connection before the client ever POSTs.
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "GET",
    headers: { authorization: `Bearer ${process.env.PAGEFETCH_TOKEN ?? ""}`, accept: "text/event-stream" },
  })

  assert.equal(response.status, 405)
  assert.equal(response.headers.get("allow"), "POST")
})
