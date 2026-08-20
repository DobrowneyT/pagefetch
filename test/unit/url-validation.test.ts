import test from "node:test"
import assert from "node:assert/strict"
import { isPrivateAddress, validateUrlSyntax, validateUrl } from "../../src/url-validation.js"

test("rejects literal addresses that must never be fetched", () => {
  const forbidden = [
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", // the one that matters
    "http://0.0.0.0/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
  ]
  for (const url of forbidden) {
    assert.equal(validateUrlSyntax(url).ok, false, `${url} should be rejected`)
  }
})

test("allows ordinary public addresses", () => {
  for (const url of ["http://8.8.8.8/", "https://93.184.216.34/", "http://172.15.0.1/", "http://172.32.0.1/"]) {
    assert.equal(validateUrlSyntax(url).ok, true, `${url} should be allowed`)
  }
})

test("rejects reserved namespaces and reserved names", () => {
  for (const url of [
    "http://localhost/",
    "http://foo.localhost/",
    "http://db.internal/",
    "http://printer.local/",
    "http://thing.home.arpa/",
  ]) {
    assert.equal(validateUrlSyntax(url).ok, false, `${url} should be rejected`)
  }
})

test("rejects every scheme but http and https", () => {
  for (const url of ["file:///etc/passwd", "ftp://example.org/", "gopher://example.org/", "data:text/html,hi"]) {
    assert.equal(validateUrlSyntax(url).ok, false, `${url} should be rejected`)
  }
})

test("rejects credentials in the URL, which are also a parser-confusion trick", () => {
  const verdict = validateUrlSyntax("http://example.org@169.254.169.254/")
  assert.equal(verdict.ok, false)
})

test("the allowlist is the only way past the private-address check", () => {
  assert.equal(validateUrlSyntax("http://fixture:3000/csr").ok, false)
  assert.equal(validateUrlSyntax("http://fixture:3000/csr", new Set(["fixture"])).ok, true)
  // and it does not leak to anything else
  assert.equal(validateUrlSyntax("http://169.254.169.254/", new Set(["fixture"])).ok, false)
})

test("a public hostname resolving to a private address is rejected", async () => {
  // localtest.me and friends resolve to 127.0.0.1 by design. If DNS is
  // unavailable the validator refuses anyway, which is the safe direction, so
  // this asserts only that the verdict is a rejection.
  const verdict = await validateUrl("http://localtest.me/")
  assert.equal(verdict.ok, false)
})

test("isPrivateAddress refuses anything it cannot parse", () => {
  for (const value of ["", "not-an-ip", "999.999.999.999", "0x7f.1"]) {
    assert.equal(isPrivateAddress(value), true, `${value} should be refused`)
  }
})

test("a host that does not resolve is unreachable, not invalid", async () => {
  // The codes say opposite things about retrying. `invalid_url` means the URL is
  // wrong and a caller should give up; a transient resolver failure means the
  // origin is unreachable right now and is worth one retry. Folding them
  // together made an agent abandon a page that would work a minute later.
  const verdict = await validateUrl("https://this-name-does-not-exist.invalid/")
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.refusal, "unreachable")
})

test("a name resolving to a private address is still invalid_url", async () => {
  // The security verdict must not move. A resolution FAILURE carries no SSRF
  // risk — there is no address to be tricked by — but a resolution to
  // 127.0.0.1 is the attack, and it stays a refusal about the URL.
  const verdict = await validateUrl("http://localtest.me/")
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.equal(verdict.refusal, "invalid_url")
})

test("every syntax refusal is a judgement about the URL", async () => {
  for (const url of [
    "http://169.254.169.254/",
    "http://127.0.0.1/",
    "ftp://example.com/",
    "http://user:pass@example.com/",
    "http://postgres:5432/",
    "http://localhost/",
    "not-a-url",
  ]) {
    const verdict = validateUrlSyntax(url)
    assert.equal(verdict.ok, false, `${url} should be refused`)
    if (!verdict.ok) assert.equal(verdict.refusal, "invalid_url", `${url} should be invalid_url`)
  }
})
