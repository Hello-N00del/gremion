#!/usr/bin/env node
// node --test suite for the German translation guard. Each RED case mutates a
// throwaway tree and asserts on the report text. Top-level test() declarations only
// (scripts/verify/suites/unit.mjs cross-checks the declared count with node's).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ROOT, REQUIRED_PAIRS, enHash, marker, enSwitch, deSwitch, findPairs, runChecks, stamp } from './check-doc-translations.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'doctr-'))
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  const get = (rel) => readFileSync(join(root, rel), 'utf8')
  const pair = (en, body = 'Text') => {
    const base = en.split('/').pop()
    const enText = `${enSwitch(base)}\n\n# Title\n\n${body}\n`
    put(en, enText)
    put(en.replace(/\.md$/, '.de.md'), `${marker(base, enHash(enText))}\n${deSwitch(base)}\n\n# Titel\n\nText\n`)
  }
  pair('README.md')
  pair('docs/guide.md')
  return { root, put, get, pair, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const failures = (root, required = []) => runChecks(root, required).failures

test('the real tree passes, every agreed pair is present, and the scan is not vacuous', () => {
  const { pairs, failures: bad } = runChecks(ROOT)
  assert.deepEqual(bad, [])
  assert.ok(REQUIRED_PAIRS.length >= 19, 'the agreed set is pinned')
  for (const en of REQUIRED_PAIRS) assert.ok(pairs.includes(en), `expected a German sibling of ${en}`)
})

test('baseline fixture is green', () => {
  const f = fixture()
  try {
    assert.deepEqual(failures(f.root), [])
    assert.deepEqual(findPairs(f.root), ['README.md', 'docs/guide.md'])
  } finally {
    f.cleanup()
  }
})

test('RED: an English edit without a German update is stale', () => {
  const f = fixture()
  try {
    f.put('docs/guide.md', f.get('docs/guide.md') + '\nA new paragraph.\n')
    assert.match(failures(f.root).join('\n'), /docs\/guide\.de\.md is stale: docs\/guide\.md changed since the German text was last synced/)
  } finally {
    f.cleanup()
  }
})

test('line endings do not count as a change', () => {
  const f = fixture()
  try {
    f.put('docs/guide.md', f.get('docs/guide.md').replace(/\n/g, '\r\n'))
    assert.deepEqual(failures(f.root), [])
  } finally {
    f.cleanup()
  }
})

test('RED: a German file with no English sibling', () => {
  const f = fixture()
  try {
    f.put('docs/orphan.de.md', `${marker('orphan.md', 'a'.repeat(64))}\n${deSwitch('orphan.md')}\n`)
    assert.match(failures(f.root).join('\n'), /docs\/orphan\.de\.md has no English sibling docs\/orphan\.md/)
  } finally {
    f.cleanup()
  }
})

test('RED: a missing or malformed marker, and one naming the wrong source', () => {
  const f = fixture()
  try {
    f.put('docs/guide.de.md', f.get('docs/guide.de.md').split('\n').slice(1).join('\n'))
    assert.match(failures(f.root).join('\n'), /docs\/guide\.de\.md does not start with an i18n-sync marker/)
    f.put('docs/guide.de.md', `${marker('other.md', enHash(f.get('docs/guide.md')))}\n${deSwitch('guide.md')}\n`)
    assert.match(failures(f.root).join('\n'), /docs\/guide\.de\.md: the marker names source=other\.md, expected guide\.md/)
  } finally {
    f.cleanup()
  }
})

test('RED: a switcher line missing on either side', () => {
  const f = fixture()
  try {
    f.put('docs/guide.de.md', f.get('docs/guide.de.md').replace(deSwitch('guide.md'), 'no switcher'))
    assert.match(failures(f.root).join('\n'), /docs\/guide\.de\.md lacks the switcher line/)
    f.pair('docs/guide.md')
    const en = f.get('docs/guide.md').replace(enSwitch('guide.md'), 'no switcher')
    f.put('docs/guide.md', en)
    stamp(f.root, ['docs/guide.de.md'])
    assert.match(failures(f.root).join('\n'), /docs\/guide\.md lacks the switcher line/)
  } finally {
    f.cleanup()
  }
})

test('RED: an English switcher that points at a German file that does not exist', () => {
  const f = fixture()
  try {
    f.put('docs/lonely.md', `${enSwitch('lonely.md')}\n\n# Lonely\n`)
    assert.match(failures(f.root).join('\n'), /docs\/lonely\.md links \.\/lonely\.de\.md, which does not exist/)
  } finally {
    f.cleanup()
  }
})

test('RED: an agreed pair whose German file was removed', () => {
  const f = fixture()
  try {
    rmSync(join(f.root, 'docs/guide.de.md'))
    f.put('docs/guide.md', '# Title\n')
    assert.match(failures(f.root, ['docs/guide.md']).join('\n'), /docs\/guide\.md is in the agreed set but has no German sibling docs\/guide\.de\.md/)
  } finally {
    f.cleanup()
  }
})

test('RED: an empty scan proves nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'doctr-empty-'))
  try {
    assert.match(failures(root).join('\n'), /no \*\.de\.md file found: an empty scan proves nothing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stamp re-records the English hash and touches nothing else', () => {
  const f = fixture()
  try {
    f.put('docs/guide.md', f.get('docs/guide.md') + '\nMore.\n')
    const before = f.get('docs/guide.de.md').split('\n').slice(1).join('\n')
    assert.deepEqual(stamp(f.root, ['docs/guide.de.md']), ['docs/guide.de.md'])
    assert.equal(f.get('docs/guide.de.md').split('\n').slice(1).join('\n'), before)
    assert.deepEqual(failures(f.root), [])
    assert.throws(() => stamp(f.root, ['docs/guide.md']), /not a \.de\.md file/)
  } finally {
    f.cleanup()
  }
})

test('node_modules and dot directories are not scanned', () => {
  const f = fixture()
  try {
    f.put('node_modules/x/README.de.md', 'no marker\n')
    f.put('.git/x.de.md', 'no marker\n')
    assert.deepEqual(failures(f.root), [])
  } finally {
    f.cleanup()
  }
})
