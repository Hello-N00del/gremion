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
  it('verify-gate: it waits for lint, the verify jobs and the image builds, so the glossary does not say it is the last job or waits for the other jobs', () => {
    // ci.yml: the needs of verify-gate are lint, the verify jobs, docker-build and the filter changes. integration-test,
    // e2e-smoke and codemap-stale are not among them and can finish after it.
    const g = text.glossary['verify-gate']
    expect(g).not.toMatch(/last job/i)
    expect(g).not.toMatch(/waits for the other jobs/i)
    expect(g).toMatch(/waits for lint, for the verify jobs and for the image builds/)
    expect(g).toMatch(/does not wait for them/)
  })

  it('verify-gate: no text says that it does not wait for docker-build', () => {
    // ci.yml: docker-build is in the needs of verify-gate, so a failed image build makes the verdict red.
    const gateStep = step('CI: a change is checked and becomes an image', 'job:.github/workflows/ci.yml#verify-gate')
    expect(gateStep).not.toMatch(/does not wait for docker-build/)
    expect(gateStep).toMatch(/for docker-build/)
    const ci = text.areas['area:github-actions/ci@L0']
    expect(ci.leadsTo).not.toMatch(/docker-build, integration-test and e2e-smoke run beside it/)
    expect(ci.leadsTo).toMatch(/waits for lint, for the verify jobs and for the job docker-build/)
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

describe('claims about the docker folders that must stay true', () => {
  const area = (id) => text.areas[id]

  it('element-call: the lint refuses an image of another owner on the GitHub registry, not every image of another owner', () => {
    // scripts/release/check-image-digests.mjs refuses a ghcr.io reference that is not exactly ours (isFirstPartyLookalike).
    // docker-compose.yml also names livekit/livekit-server by digest: another owner on another registry is accepted.
    const why = area('area:docker/element-call@L0').why
    expect(why).not.toMatch(/refuses an image of another owner in the compose file/)
    expect(why).toMatch(/on the registry of GitHub/)
    // the page scan refuses a host name, so the text cannot name the registry host
    expect(why).not.toMatch(/ghcr[.]io/)
  })

  it('livekit: empty_timeout covers a room that nobody joined; after a person left, departure_timeout (20 s by default) applies', () => {
    // livekit v1.7.2 pkg/rtc/room.go: FirstJoinedAt > 0 && LastLeftAt > 0 uses DepartureTimeout, else EmptyTimeout.
    const what = area('area:docker/livekit@L0').what
    expect(what).not.toMatch(/after the last person leaves/)
    expect(what).toMatch(/room that nobody joins closes after five minutes/)
  })

  it('test/isolation/tenant: the tree is mounted; the clone is what keeps an untracked file out', () => {
    // infra/host/bin/gremion-isolation mounts the release tree at /src and runs git clone --no-hardlinks /src /work/tree.
    const why = area('area:dockerfile:test/isolation/tenant@L0').why
    expect(why).not.toMatch(/image holds no repository code, so/)
    expect(why).toMatch(/gets the release tree/)
    expect(why).toMatch(/clone/)
  })

  it('the glossary names the tools that the tenant text uses', () => {
    for (const term of ['gremion-isolation', 'pnpm']) expect(Object.keys(text.glossary)).toContain(term)
  })
})
