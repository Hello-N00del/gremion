#!/usr/bin/env node
// R33 F5 guard (audit rows 14 and 15, operator ruling Q3 2026-10-21): messaging, files, publishing (newsletter),
// elections and votes are deselectable at RUNTIME per tenant. A manifest that says toggleable:false or carries no
// routePrefixes is never reached by the module-disable gate, so switching the module off changes nothing - the
// silent false-green this test refuses. It reads the manifest SOURCE (the module app trees are overlays onto the
// StuRaOS gremion-ui and cannot be imported in the kernel build).
// Test: node --test scripts/check-module-deselectable.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DESELECTABLE = [
  ['files', 'modules/files/app/lib/modules/manifests/files.ts'],
  ['messages', 'modules/messaging/app/lib/modules/manifests/messages.ts'],
  ['newsletter', 'modules/publishing/app/lib/modules/manifests/newsletter.ts'],
  ['elections', 'modules/elections/app/lib/modules/manifests/elections.ts'],
  ['votes', 'modules/votes/app/lib/modules/manifests/votes.ts'],
  ['calendar', 'modules/calendar/app/lib/modules/manifests/calendar.ts'],
]
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

for (const [id, rel] of DESELECTABLE) {
  const src = strip(readFileSync(join(ROOT, rel), 'utf8'))
  test(`${id}: declares id, toggleable:true and non-empty routePrefixes`, () => {
    assert.ok(src.includes(`id: '${id}'`), `${rel} must declare id '${id}'`)
    assert.match(src, /toggleable:\s*true/, `${rel} must be toggleable:true`)
    const m = src.match(/routePrefixes:\s*\[([^\]]*)\]/)
    assert.ok(m, `${rel} must declare routePrefixes`)
    assert.ok(/'\/[^']+'/.test(m[1]), `${rel} routePrefixes must not be empty`)
  })
}

test('newsletter prefixes do not cover kernel system mail (the leaf service callbacks stay outside the gate)', () => {
  const src = strip(readFileSync(join(ROOT, 'modules/publishing/app/lib/modules/manifests/newsletter.ts'), 'utf8'))
  const prefixes = [...src.match(/routePrefixes:\s*\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  for (const p of ['/api/internal/newsletter/send-mail', '/api/settings', '/api/notifications']) {
    assert.ok(!prefixes.some((pre) => p === pre || p.startsWith(pre + '/')), `${p} must stay outside the newsletter gate`)
  }
})

test('/polls and /votes are owned by votes only (elections can be deselected separately)', () => {
  const el = strip(readFileSync(join(ROOT, 'modules/elections/app/lib/modules/manifests/elections.ts'), 'utf8'))
  assert.doesNotMatch(el, /'\/(polls|votes)'/)
  const vo = strip(readFileSync(join(ROOT, 'modules/votes/app/lib/modules/manifests/votes.ts'), 'utf8'))
  assert.match(vo, /'\/votes'/)
  assert.match(vo, /'\/polls'/)
})
