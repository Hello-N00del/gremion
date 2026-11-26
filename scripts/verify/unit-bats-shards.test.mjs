// The bats files run as BATS_SHARDS parts so CI can give each its own leg, plus one part
// of their own for the slow end-to-end CD pipeline file. The parts are only safe if they
// PARTITION the glob: a file in no part is a file nobody runs (and the record would still
// read green), a file in two is counted twice.
import assert from 'node:assert/strict'
import { globSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import * as unitSuite from './suites/unit.mjs'
import { BATS_PATTERNS, BATS_SHARDS, batsShardFiles, UNIT_PARTS } from './suites/unit.mjs'
import { REPO_ROOT } from './lib/vitest.mjs'

const PIPELINE_PART = 'bats-cd-pipeline'
const PIPELINE_FILE = 'test/host/cd-pipeline.bats'

const repoBatsFiles = () => BATS_PATTERNS.flatMap((p) => globSync(p, { cwd: REPO_ROOT }))

test('the bats parts partition the repository\'s bats files: each file in exactly one part, no part empty', () => {
  const all = batsShardFiles(repoBatsFiles())
  assert.ok(all.length >= BATS_SHARDS * 5, `only ${all.length} bats file(s) found -- this test is not looking at the suite`)
  const seen = new Map()
  const note = (part, files) => {
    assert.ok(files.length > 0, `part ${part} is empty`)
    for (const f of files) seen.set(f, [...(seen.get(f) ?? []), part])
  }
  for (let index = 1; index <= BATS_SHARDS; index++) {
    note(`shard ${index} of ${BATS_SHARDS}`, batsShardFiles(repoBatsFiles(), { index, of: BATS_SHARDS }))
  }
  note(PIPELINE_PART, unitSuite.batsPipelineFiles(repoBatsFiles()))
  assert.deepEqual([...seen.keys()].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)), all, 'the parts together are not the whole file list')
  const twice = [...seen].filter(([, parts]) => parts.length > 1)
  assert.deepEqual(twice, [], 'a file is in more than one part')
})

test('the CD pipeline file runs alone in its own part and in no shard', () => {
  const files = repoBatsFiles()
  assert.deepEqual(unitSuite.batsPipelineFiles(files), [PIPELINE_FILE])
  for (let index = 1; index <= BATS_SHARDS; index++) {
    assert.ok(!batsShardFiles(files, { index, of: BATS_SHARDS }).includes(PIPELINE_FILE), `shard ${index} still runs ${PIPELINE_FILE}`)
  }
})

test('the pipeline selection and the shard exclusion agree on a synthetic list, whatever the separator', () => {
  const posix = ['test/a.bats', PIPELINE_FILE, 'test/host/b.bats', 'test/c.bats']
  const win = posix.map((f) => f.split('/').join(path.sep)).reverse()
  for (const list of [posix, win]) {
    assert.deepEqual(unitSuite.batsPipelineFiles(list), [PIPELINE_FILE])
    assert.deepEqual(batsShardFiles(list, { index: 1, of: 2 }), ['test/a.bats', 'test/host/b.bats'])
    assert.deepEqual(batsShardFiles(list, { index: 2, of: 2 }), ['test/c.bats'])
  }
})

test('a shard is the same set of files whatever the platform separator and input order', () => {
  const posix = ['test/b.bats', 'test/host/a.bats', 'test/a.bats', 'test/host/c.bats']
  const win = posix.map((f) => f.split('/').join(path.sep)).reverse()
  for (let index = 1; index <= 2; index++) {
    assert.deepEqual(batsShardFiles(win, { index, of: 2 }), batsShardFiles(posix, { index, of: 2 }))
  }
  assert.deepEqual(batsShardFiles(posix, { index: 1, of: 2 }), ['test/a.bats', 'test/host/a.bats'])
  assert.deepEqual(batsShardFiles(posix, { index: 2, of: 2 }), ['test/b.bats', 'test/host/c.bats'])
})

test('a shard index outside 1..of is refused, never an empty (or whole) selection', () => {
  for (const shard of [{ index: 0, of: 2 }, { index: 3, of: 2 }, { index: 1, of: 0 }, { index: 1.5, of: 2 }]) {
    assert.throws(() => batsShardFiles(['test/a.bats'], shard), /invalid bats shard/)
  }
})

test('UNIT_PARTS has one bats-<i>-of-<n> part per shard, the CD pipeline part, and no whole-set bats part beside them', () => {
  const batsKeys = Object.keys(UNIT_PARTS).filter((k) => k.startsWith('bats')).sort()
  const expected = [...Array.from({ length: BATS_SHARDS }, (_, i) => `bats-${i + 1}-of-${BATS_SHARDS}`), PIPELINE_PART].sort()
  assert.deepEqual(batsKeys, expected)
})
