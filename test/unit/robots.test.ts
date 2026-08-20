import test from "node:test"
import assert from "node:assert/strict"
import { isAllowed, parseRobots } from "../../src/robots.js"

const allowed = (robots: string, path: string) => isAllowed(parseRobots(robots), path)

test("a group that is not ours does not apply to us", () => {
  // scholarshipscanada.com, once the challenge stopped hiding it: every group is
  // named, and none of them is `*`. No rules apply, so nothing is disallowed.
  const robots = `User-agent: AhrefsBot
Disallow: /

User-agent: SemrushBot
Disallow: /`
  assert.equal(allowed(robots, "/Sitemap/Scholarships.xml"), true)
  assert.equal(allowed(robots, "/scholarships"), true)
})

test("an explicit Allow: / permits everything", () => {
  // findaphd.com. The PRD recorded this as `Disallow: /`, which was wrong.
  assert.equal(allowed("User-agent: *\nAllow: /", "/phds/"), true)
})

test("longest match wins, and Allow breaks a tie", () => {
  const robots = `User-agent: *
Disallow: /private
Allow: /private/public`
  assert.equal(allowed(robots, "/private/secret"), false)
  assert.equal(allowed(robots, "/private/public/page"), true)

  // Equal length, opposite verdicts: RFC 9309 says the Allow wins.
  assert.equal(allowed("User-agent: *\nDisallow: /a\nAllow: /a", "/a"), true)
})

test("wildcards and the end anchor", () => {
  assert.equal(allowed("User-agent: *\nDisallow: /*.pdf$", "/files/report.pdf"), false)
  assert.equal(allowed("User-agent: *\nDisallow: /*.pdf$", "/files/report.pdf.html"), true)
  assert.equal(allowed("User-agent: *\nDisallow: /a/*/c", "/a/b/c"), false)
})

test("an empty Disallow disallows nothing", () => {
  assert.equal(allowed("User-agent: *\nDisallow:", "/anything"), true)
})

test("a trailing-slash Disallow does not cover the bare path — RFC 9309", () => {
  // careers.arm.com's entire robots.txt is `Disallow:/search-jobs/`, and the
  // paths beneath it are that platform's AJAX endpoints. It leaves every
  // /job/<slug>/… detail page allowed, so reading the slash as "job search is
  // closed" is incoherent — you cannot block the index while publishing every
  // entry. This briefly matched the bare path and over-blocked a page ARM
  // permits.
  const arm = "User-agent: *\nDisallow: /search-jobs/"
  assert.equal(allowed(arm, "/search-jobs"), true)
  assert.equal(allowed(arm, "/search-jobs?k=embedded"), true)

  // The subtree is still refused, which is what the rule actually says.
  assert.equal(allowed(arm, "/search-jobs/"), false)
  assert.equal(allowed(arm, "/search-jobs/results"), false)
  assert.equal(allowed(arm, "/search-jobs/resultspost"), false)
})

test("a prefix match is a prefix match, not a path-segment match", () => {
  // The other half of RFC 9309 that is tempting to improve on. `Disallow: /a`
  // really does cover `/abc`, and a site that means otherwise writes `/a/`.
  assert.equal(allowed("User-agent: *\nDisallow: /search-jobs", "/search-jobs-archive"), false)
  assert.equal(allowed("User-agent: *\nDisallow: /search-jobs/", "/search-jobs-archive"), true)
})

test("Disallow: / still blocks everything", () => {
  // linkedin.com/robots.txt, in effect. The trailing-slash rule must not turn
  // the root disallow into something narrower.
  assert.equal(allowed("User-agent: *\nDisallow: /", "/jobs/search"), false)
  assert.equal(allowed("User-agent: *\nDisallow: /", "/"), false)
})

test("consecutive user-agent lines share one group", () => {
  const robots = `User-agent: Googlebot
User-agent: *
Disallow: /admin`
  assert.equal(allowed(robots, "/admin/panel"), false)
  assert.equal(allowed(robots, "/public"), true)
})
