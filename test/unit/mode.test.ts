import test from "node:test"
import assert from "node:assert/strict"
import { challengeAdvice, fetchMode } from "../../src/config.js"

// A `blocked_challenge` means two different things depending on which kind of
// browser produced it, and the caller cannot tell from the code alone. From a
// launched browser it means "an attached one may get through" — measured, that
// is what unlocked two of the five aggregators. From an attached browser it
// means capability is exhausted and the answer is stop.

test("the mode follows whether we launched the browser or attached to one", () => {
  assert.equal(fetchMode({ cdpUrl: null }), "launched")
  assert.equal(fetchMode({ cdpUrl: "http://127.0.0.1:9222" }), "attached")
})

test("the advice differs, and says what to do rather than what happened", () => {
  const launched = challengeAdvice({ cdpUrl: null })
  const attached = challengeAdvice({ cdpUrl: "http://127.0.0.1:9222" })

  assert.notEqual(launched, attached)
  assert.match(launched, /attached/, "a launched refusal should point at the mode that may work")
  assert.match(attached, /stop/, "an attached refusal is the end of the line")
})
