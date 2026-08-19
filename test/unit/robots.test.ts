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

test("a trailing-slash Disallow covers the bare path — issue #13", () => {
  // careers.arm.com writes `Disallow: /search-jobs/`. Under strict RFC 9309
  // prefix matching `/search-jobs` is permitted, which is the letter of what
  // they wrote and obviously not what they meant.
  const arm = "User-agent: *\nDisallow: /search-jobs/"
  assert.equal(allowed(arm, "/search-jobs"), false)
  assert.equal(allowed(arm, "/search-jobs/"), false)
  assert.equal(allowed(arm, "/search-jobs/12345"), false)
})

test("the trailing-slash rule matches the directory only, not a longer sibling", () => {
  // The risk of the deviation is over-blocking. `/search-jobs-archive` shares a
  // prefix with `/search-jobs` but is a different place, and stays fetchable.
  const arm = "User-agent: *\nDisallow: /search-jobs/"
  assert.equal(allowed(arm, "/search-jobs-archive"), true)
  assert.equal(allowed(arm, "/search-jobsomething"), true)
  assert.equal(allowed(arm, "/careers"), true)
})

test("a site that deliberately allows the bare path still gets it", () => {
  // The one case where the deviation could take something away. `Allow: /docs`
  // and `Disallow: /docs/` together is a site saying the index page is fine and
  // the tree is not; the directory-form match ties rather than beating it, so
  // the Allow wins and the site gets what it asked for.
  const robots = `User-agent: *
Disallow: /docs/
Allow: /docs`
  assert.equal(allowed(robots, "/docs"), true)
  assert.equal(allowed(robots, "/docs/internal"), false)
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
