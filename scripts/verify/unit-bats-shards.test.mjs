// The bats files run as BATS_SHARDS parts so CI can give each its own leg. The shards
// are only safe if they PARTITION the glob: a file in no shard is a file nobody runs
// (and the record would still read green), a file in two is counted twice.
import assert from 'node:assert/strict'
import { globSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { BATS_PATTERNS, BATS_SHARDS, batsShardFiles, UNIT_PARTS } from './suites/unit.mjs'
import { REPO_ROOT } from './lib/vitest.mjs'

const repoBatsFiles = () => BATS_PATTERNS.flatMap((p) => globSync(p, { cwd: REPO_ROOT }))

test('the bats shards partition the repository\'s bats files: each file in exactly one shard, no shard empty', () => {
  const all = batsShardFiles(repoBatsFiles())
  assert.ok(all.length >= BATS_SHARDS * 5, `only ${all.length} bats file(s) found -- this test is not looking at the suite`)
  const seen = new Map()
  for (let index = 1; index <= BATS_SHARDS; index++) {
    const files = batsShardFiles(repoBatsFiles(), { index, of: BATS_SHARDS })
    assert.ok(files.length > 0, `shard ${index} of ${BATS_SHARDS} is empty`)
    for (const f of files) seen.set(f, [...(seen.get(f) ?? []), index])
  }
  assert.deepEqual([...seen.keys()].sort(), all, 'the shards together are not the whole file list')
  const twice = [...seen].filter(([, shards]) => shards.length > 1)
  assert.deepEqual(twice, [], 'a file is in more than one shard')
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

test('UNIT_PARTS has one bats-<i>-of-<n> part per shard and no whole-set bats part beside them', () => {
  const batsKeys = Object.keys(UNIT_PARTS).filter((k) => k.startsWith('bats')).sort()
  assert.deepEqual(batsKeys, Array.from({ length: BATS_SHARDS }, (_, i) => `bats-${i + 1}-of-${BATS_SHARDS}`).sort())
})
