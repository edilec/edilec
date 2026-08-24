import assert from "node:assert/strict"
import test from "node:test"

import {escapeXml, parseRepositories, renderSignal, summarize} from "./render-engineering-signal.mjs"

const repositories = [
  {
    name: "safe-tool",
    language: "JavaScript",
    license: "MIT",
    release: "v1.0.0",
    security: true,
    ci: "success",
  },
  {
    name: "needs-review",
    language: "Python",
    license: null,
    release: null,
    security: false,
    ci: "configured",
  },
]

test("repository allowlist parsing is bounded and strict", () => {
  assert.deepEqual(parseRepositories("edilec/one, edilec/two, edilec/one"), ["edilec/one", "edilec/two"])
  assert.throws(() => parseRepositories("https://github.com/edilec/one"))
  assert.throws(() => parseRepositories(""))
})

test("summary uses only observed repository evidence", () => {
  assert.deepEqual(summarize(repositories), {
    total: 2,
    released: 1,
    passing: 1,
    secured: 1,
    licensed: 1,
  })
})

test("SVG output is escaped, themed, and semantically marked", () => {
  assert.equal(escapeXml("<unsafe>&"), "&lt;unsafe&gt;&amp;")
  for (const layout of ["desktop", "mobile"]) {
    const svg = renderSignal(repositories, {
      theme: "dark",
      label: "Edilec & Team",
      profile: "company",
      layout,
    })
    assert.match(svg, /^<svg /)
    assert.match(svg, /data-component="repository-evidence"/)
    assert.match(svg, /data-schema="1"/)
    assert.match(svg, /data-profile="company"/)
    assert.match(svg, new RegExp(`data-layout="${layout}"`))
    assert.match(svg, /data-signal="engineering"/)
    assert.match(svg, /data-repositories="2"/)
    assert.match(svg, /data-repository="safe-tool"/)
    assert.match(svg, /data-release="v1.0.0"/)
    assert.match(svg, /Edilec &amp; Team/)
    assert.doesNotMatch(svg, /<(script|foreignObject|image|iframe|object|embed|link|meta|use)([\s>])|javascript:/i)
    assert.doesNotMatch(svg, /(href|xlink:href|src)\s*=\s*["'](?:https?:)?\/\//i)
  }
})
