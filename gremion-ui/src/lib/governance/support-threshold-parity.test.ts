// Cross-mirror FIDELITY test (Civitas Governance Core INV-5). This is the test
// class whose absence let the support_threshold client/server divergence survive:
// it imports BOTH evaluators — the authoritative server rule
// (`evaluateDecisionRule`, $lib/server) and the DISPLAY-ONLY client mirror
// (`computeResult`) — and asserts they return an IDENTICAL verdict over a full
// parameter sweep: all 5 core rules × a grid of yes/no/abstain/eligible, INCLUDING
// the IEEE-754 float-noise fractions (0.55, 0.07, 0.1) that first exposed the bug.
// If either side's rule math drifts, this fails immediately.
import { describe, it, expect, beforeEach } from 'vitest'
import { computeResult, type MajorityRule } from './compute-result'
import { evaluateDecisionRule } from '$lib/server/governance/decision-rule'
import { _resetRuntimeRegistryForTests } from '$lib/server/modules/runtime-registry'

const RULES: MajorityRule[] = ['simple', 'two_thirds', 'absolute', 'consent', 'support_threshold']
// Float-noise fractions (0.55, 0.07, 0.1 all multiply to a value just above an
// integer in double precision) + true fractional / integer-boundary fractions.
const FRACTIONS = [0.07, 0.1, 0.25, 0.5, 0.55, 0.75, 1]
const ELIGIBLES = [7, 10, 20, 100]

describe('cross-mirror fidelity: computeResult (client) === evaluateDecisionRule (server)', () => {
  beforeEach(() => {
    // Core rules resolve from the frozen strategy Map, but reset the module
    // registry anyway so no cross-test registration can influence resolution.
    _resetRuntimeRegistryForTests()
  })

  it('all 5 rules agree over a yes/no/abstain/eligible sweep incl. IEEE-754 fractions', () => {
    const mismatches: string[] = []
    for (const eligible of ELIGIBLES) {
      for (let yes = 0; yes <= eligible; yes++) {
        for (let no = 0; yes + no <= eligible; no++) {
          for (const abstain of [0, 1]) {
            for (const rule of RULES) {
              const fractions = rule === 'support_threshold' ? FRACTIONS : [undefined]
              for (const fraction of fractions) {
                const server = evaluateDecisionRule(rule, {
                  yes,
                  no,
                  abstain,
                  eligible,
                  present: yes + no,
                  params: fraction === undefined ? null : { fraction },
                })
                  ? 'passed'
                  : 'rejected'
                const client = computeResult(
                  yes,
                  no,
                  rule,
                  eligible,
                  rule === 'support_threshold' ? fraction : undefined,
                )
                if (client !== server) {
                  mismatches.push(
                    `rule=${rule} yes=${yes} no=${no} abstain=${abstain} eligible=${eligible}` +
                      (fraction === undefined ? '' : ` fraction=${fraction}`) +
                      ` → client=${client} server=${server}`,
                  )
                }
              }
            }
          }
        }
      }
    }
    // Empty ⇒ the mirror and the authority agree on every swept tuple.
    expect(mismatches).toEqual([])
  })
})
