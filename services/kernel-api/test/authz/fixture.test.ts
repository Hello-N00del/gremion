// TDD 17: the TASK-080 stand-in fixture's plumbing block IS plumbingSql('idt')
// byte for byte (until 080 merges and the fixture is dropped, plan s.1).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkPlumbingText, plumbingSql } from '@gremion/events'
import { describe, expect, it } from 'vitest'

const FIXTURE = fileURLToPath(new URL('./fixtures/idt-080.sql', import.meta.url))
const text = () => readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n')

describe('fixtures/idt-080.sql', () => {
  it('starts with plumbingSql(idt) byte for byte', () => {
    expect(text().startsWith(plumbingSql('idt'))).toBe(true)
    expect(() => checkPlumbingText(text(), 'idt')).not.toThrow()
  })
  it('a drifted plumbing block is refused by name', () => {
    const drifted = text().replace('CREATE SCHEMA IF NOT EXISTS idt;', 'CREATE SCHEMA IF NOT EXISTS idt; -- drift')
    expect(() => checkPlumbingText(drifted, 'idt')).toThrow(/byte/i)
  })
})
