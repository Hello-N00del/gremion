#!/usr/bin/env node
// modules/board/test/bundle-smoke.mjs — R29-BOARD-STORE-K A10.
//
// Boots the esbuild bundle (dist/index.js, ONE depth-1 file) the way the image
// runs it, with a stub env, and proves:
//   1. it boots: /healthz answers 200 {"status":"ok"} within 5 s, and stderr
//      carries no ENOENT. The schema gate loads migrations/manifest.json when
//      buildApp constructs it, so a MIGRATIONS_DIR resolved from the wrong depth
//      (two '..' from a depth-2 source file → /migrations beside the bundle's
//      parent) kills the boot here.
//   2. it refuses to boot without GREMION_BOARD_PG_URL: exit 1 within 5 s, one
//      stderr line naming the variable (Q8; a leaf that boots healthy and fails
//      every call is a silent failure).
// The stub url points at 127.0.0.1:1; nothing connects at boot.
//
// Run: pnpm --filter board-service test:bundle   (builds first)
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const DEADLINE_MS = 5000

function fail(msg) {
  console.error(`[bundle-smoke] FAIL — ${msg}`)
  process.exit(1)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function start(env) {
  const base = { ...process.env }
  delete base.GREMION_BOARD_PG_URL
  delete base.BOARD_PG_URL
  const child = spawn(process.execPath, [DIST], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const out = { stdout: '', stderr: '', exit: null }
  child.stdout.on('data', (c) => (out.stdout += c))
  child.stderr.on('data', (c) => (out.stderr += c))
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve((out.exit = code))))
  return { child, out, exited }
}

async function healthz(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
    return { status: r.status, body: await r.text() }
  } catch {
    return null
  }
}

if (!existsSync(DIST)) fail(`${DIST} is missing — run pnpm build first`)

// ── 1. boots healthy, no ENOENT ──────────────────────────────────────────
{
  const port = await freePort()
  const { child, out } = start({
    GREMION_BOARD_PG_URL: 'postgres://smoke@127.0.0.1:1/postgres',
    INTERNAL_BOARD_SECRET: 'bundle-smoke-secret',
    PORT: String(port),
  })
  const until = Date.now() + DEADLINE_MS
  let answer = null
  while (Date.now() < until && out.exit === null) {
    answer = await healthz(port)
    if (answer) break
    await new Promise((r) => setTimeout(r, 100))
  }
  child.kill()
  if (!answer) fail(`no /healthz answer within ${DEADLINE_MS} ms (exit ${out.exit}); stderr:\n${out.stderr}`)
  if (answer.status !== 200 || JSON.parse(answer.body).status !== 'ok') fail(`/healthz answered ${answer.status} ${answer.body}`)
  if (/ENOENT/.test(out.stderr)) fail(`stderr carries ENOENT:\n${out.stderr}`)
  console.log(`[bundle-smoke] ok — dist/index.js booted, /healthz 200 on :${port}, no ENOENT`)
}

// ── 2. refuses to boot without GREMION_BOARD_PG_URL ──────────────────────
{
  const { child, out, exited } = start({ INTERNAL_BOARD_SECRET: 'bundle-smoke-secret', PORT: String(await freePort()) })
  const timer = setTimeout(() => child.kill(), DEADLINE_MS)
  const code = await exited
  clearTimeout(timer)
  if (code !== 1) fail(`without GREMION_BOARD_PG_URL the bundle exited ${code} (expected 1); stderr:\n${out.stderr}`)
  const lines = out.stderr.trim().split('\n').filter(Boolean)
  if (lines.length !== 1 || !lines[0].includes('GREMION_BOARD_PG_URL')) fail(`expected one stderr line naming GREMION_BOARD_PG_URL, got:\n${out.stderr}`)
  console.log(`[bundle-smoke] ok — without GREMION_BOARD_PG_URL the bundle refused to boot: ${lines[0]}`)
}
