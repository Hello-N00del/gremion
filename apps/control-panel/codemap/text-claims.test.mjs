// Claims in ste-text.json that were once false of the workflow files, pinned so they stay corrected. This test reads
// the text only. It does NOT read .github/workflows: a rename in CI must never turn this test red (the map lists such
// drift in codemap/check.mjs and never blocks). What each claim is true of is written next to it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const text = JSON.parse(fs.readFileSync(path.join(HERE, 'ste-text.json'), 'utf8'))
const step = (title, nodeId) => text.walkthroughs.find((w) => w.title === title).steps.find((s) => s.nodeId === nodeId).text

describe('claims about the workflows that must stay true', () => {
  it('verify-gate: it waits for lint and the verify jobs only, so the glossary does not say it is the last job or waits for the other jobs', () => {
    // ci.yml: the needs of verify-gate are lint and the verify jobs. docker-build, integration-test, e2e-smoke and
    // codemap-stale are not among them and can finish after it.
    const g = text.glossary['verify-gate']
    expect(g).not.toMatch(/last job/i)
    expect(g).not.toMatch(/waits for the other jobs/i)
    expect(g).toMatch(/waits for lint and for the verify jobs/)
    expect(g).toMatch(/does not wait for them/)
  })

  it('dependabot-unpause: the job unpause runs only when the measured start time is within the limit, and the text says so', () => {
    // dependabot-unpause.yml: THRESHOLD=120 seconds; `if: needs.measure.outputs.recovered == 'true'` on the job unpause.
    const a = text.areas['area:github-actions/dependabot-unpause@L0']
    expect(a.what).toMatch(/unpause runs only when this time is 120 seconds or less/)
    expect(a.what).not.toMatch(/unpause then restores/)
    expect(a.why).toMatch(/slow to start the job measure, the job unpause does not run/)
  })

  it('docker-build: it does not claim to run ONLY when a build input changed (it also runs when the job changes fails)', () => {
    // ci.yml: `needs.changes.result == 'failure'` is a fail-safe branch of the if of docker-build.
    const t = step('CI: a change is checked and becomes an image', 'job:.github/workflows/ci.yml#docker-build')
    expect(t).not.toMatch(/runs only when a build input changed/)
    expect(t).toMatch(/runs when a build input changed/)
    expect(t).toMatch(/also runs when the job changes fails/)
  })
})
