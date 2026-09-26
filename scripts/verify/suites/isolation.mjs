// TASK-045: isolation suite (TASK-117 residual, R24-10).
//
// packages/storage/src/isolation.test.ts proves cross-tenant isolation
// through the storage seam (TRD-065/067) -- until now it ran only as a side
// effect of gremion-ui's vite `include` glob
// ('../packages/storage/src/**/*.test.ts', gremion-ui/vite.config.ts), which
// @gremion/storage's own vitest.config.ts header even documents as
// deliberate ("specs run standalone ... AND through gremion-ui's vitest").
// Nothing in verify named or pinned isolation.test.ts specifically, so
// editing that include glob, or moving the file, would silently drop the
// only proof of TRD-065/067 from the merge-blocking gate with no suite going
// red -- the same shape of defect this whole task exists to close for every
// OTHER suite (brief S1: "no suite may report pass on zero collected tests").
//
// Two parts, combined so neither can hide the other's failure:
//   1. @gremion/storage's own `test` script (`pnpm run test`), judged exactly
//      like any other vitestSubcheck.
//   2. A pin: isolation.test.ts's repo-relative path must appear among the
//      files vitest actually attempted. A glob edit that stops matching it
//      produces neither a failure nor a skip -- the file just silently is
//      not in `testResults` -- so part 1's counts alone cannot catch that.
import path from 'node:path'
import { combineParts } from '../lib/guard.mjs'
import { vitestSubcheck } from './unit.mjs'
import { REPO_ROOT } from '../lib/vitest.mjs'

export const ISOLATION_FILE = 'packages/storage/src/isolation.test.ts'

/** @param {{collectedFiles?: string[]}} vitestPart */
export function pinIsolationFilePart(vitestPart, isolationFile = ISOLATION_FILE) {
  const label = `${isolationFile} must be collected`
  const files = vitestPart.collectedFiles ?? []
  const present = files.includes(isolationFile)
  return {
    label,
    collected: 1,
    passed: present ? 1 : 0,
    failed: present ? 0 : 1,
    skipped: 0,
    detail: present ? '' : `${isolationFile} was not among the files vitest reported running (saw: ${files.join(', ') || '(none)'})`,
  }
}

export function runIsolationSuite({ root = REPO_ROOT } = {}) {
  const storageDir = path.join(root, 'packages', 'storage')
  const vitestPart = vitestSubcheck({ cwd: storageDir, testScript: 'test', root, label: '@gremion/storage vitest (test)' })
  return combineParts([vitestPart, pinIsolationFilePart(vitestPart)])
}
