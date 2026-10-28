// The committed docker/loki/loki.yaml is the render of the registry (RED recipe:
// edit a period in the file, or a figure in registry.ts, without re-rendering).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { lokiGlobalDays, renderLoki } from '../src/loki.ts'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const COMMITTED = readFileSync(resolve(ROOT, 'docker/loki/loki.yaml'), 'utf8').replace(/\r\n/g, '\n')

describe('rendered Loki retention', () => {
  it('the committed file equals the render', () => {
    expect(COMMITTED).toBe(renderLoki())
  })

  it('goes RED when the committed file is edited by hand', () => {
    const edited = COMMITTED.replace('period: 28d', 'period: 30d')
    expect(edited).not.toBe(COMMITTED)
    expect(edited).not.toBe(renderLoki())
  })

  it('renders the windows of the running config: 14/27/27/27/28, global 14 d, retention on, 24 h stale-sample refusal', () => {
    const doc = parse(renderLoki()) as {
      limits_config: { retention_period: string; retention_stream: Array<{ selector: string; period: string }>; reject_old_samples: boolean; reject_old_samples_max_age: string }
      compactor: { retention_enabled: boolean }
    }
    expect(doc.limits_config.retention_stream.map((s) => [s.selector, s.period])).toEqual([
      ['{class="access"}', '14d'], ['{class="security"}', '27d'], ['{class="finance"}', '27d'], ['{class="audit"}', '27d'], ['{class="application"}', '28d'],
    ])
    expect(doc.limits_config.retention_period).toBe('14d')
    expect(lokiGlobalDays()).toBe(14)
    expect(doc.compactor.retention_enabled).toBe(true)
    expect(doc.limits_config.reject_old_samples).toBe(true)
    expect(doc.limits_config.reject_old_samples_max_age).toBe('24h')
  })

  it('keeps the header table of TASK-039 (worst case column)', () => {
    expect(renderLoki()).toContain('#   application  28 d    29 d 2 h 10 min  RC-LOG-APP (30 d / 30 d) [A: 28 d so')
    expect(renderLoki()).toContain('#   audit        27 d    28 d 2 h 10 min  RC-LOG-AUD (27 d / 30 d, bound to SEC)')
  })
})
