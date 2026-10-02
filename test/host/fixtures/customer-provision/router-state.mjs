#!/usr/bin/env node
// router-state.mjs -- the judge behind customer-provision-proof.sh's "both
// routers of each customer are enabled" check (TASK-043c P1).
//
// A tenant router Traefik cannot load is reported by its API as
//   {"status":"disabled","error":["middleware \"edge-ratelimit-app@docker\" does not exist"]}
// while the file on disk is perfectly valid and the host answers 404. The
// proof used to look only for the router's PRESENCE, which that shape passes,
// so the defect reached the operator's run as a string of unrelated failures
// (create-3, resume, admins). This reads the STATE.
//
// Input (stdin, one JSON object): {"<router name>": <Traefik API body | null>}
// where null is a router the API did not report (HTTP 404 / no answer).
// Output: one violation per line on stdout. Exit 0 only when at least one
// router was judged and none has a violation: ZERO routers is a failure, a
// check that looked at nothing proved nothing.
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

export function judgeRouters(entries) {
  const names = Object.keys(entries ?? {})
  if (names.length === 0) return ['no router was inspected: zero routers found is a failure']
  const out = []
  for (const name of names.sort()) {
    const r = entries[name]
    if (r === null || typeof r !== 'object') {
      out.push(`${name}: not reported by Traefik`)
      continue
    }
    const errors = Array.isArray(r.error) ? r.error : r.error === undefined || r.error === null ? [] : [String(r.error)]
    if (r.status !== 'enabled') out.push(`${name}: status ${JSON.stringify(r.status ?? null)}${errors.length ? ` (${errors.join('; ')})` : ''}`)
    else if (errors.length > 0) out.push(`${name}: enabled but reports ${errors.join('; ')}`)
  }
  return out
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let entries
  try {
    entries = JSON.parse(readFileSync(0, 'utf8'))
  } catch (e) {
    console.log(`router-state: stdin is not JSON (${e.message})`)
    process.exit(1)
  }
  const violations = judgeRouters(entries)
  for (const v of violations) console.log(v)
  process.exit(violations.length === 0 ? 0 : 1)
}
