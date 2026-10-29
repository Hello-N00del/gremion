// TASK-045: integration-gate.sh's own stub() (vault
// session-2026-09-15-spec-b-d/plan/tooling/integration-gate.sh:35), shared by
// every suite that renders the compose files: carve-lint (lint-compose,
// lint-hygiene) and typecheck (gremion-ui's check-app-port-binding pre-check,
// which reports "NOT RUN: this working copy is not set up" without them). They FAIL in a bare checkout that never ran
// `make setup` -- not because anything is wrong, but because nothing was
// configured. Copy .env.example -> .env and create an empty
// legal/legal.env only if each is absent, then assert the result is
// untracked-and-ignored: a non-empty `git status` for those paths means
// something unexpected is tracked there, and stubbing refuses rather than
// silently overwriting it.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { run } from './proc.mjs'

export function stubEnvFilesIfAbsent(cwd) {
  const envPath = path.join(cwd, '.env')
  const legalDir = path.join(cwd, 'legal')
  const legalEnvPath = path.join(legalDir, 'legal.env')
  if (!existsSync(envPath)) {
    copyFileSync(path.join(cwd, '.env.example'), envPath)
  }
  if (!existsSync(legalEnvPath)) {
    mkdirSync(legalDir, { recursive: true })
    writeFileSync(legalEnvPath, '')
  }
  const status = run('git', ['status', '--porcelain', '--untracked-files=all', '--', '.env', 'legal/legal.env'], { cwd })
  if (status.code !== 0 || status.stdout.trim().length > 0) {
    throw new Error(
      'refusing to stub .env/legal/legal.env: git status is non-empty (or failed) for a path that should be gitignored -- ' +
        `something unexpected is tracked there:\n${String(status.stdout)}${String(status.stderr)}`,
    )
  }
}
