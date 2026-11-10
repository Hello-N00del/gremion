import { describe, expect, it } from 'vitest'
import { mailErrorFields } from '../src/mail-error.ts'

// What a mail failure may put in a log: its class name and the cause fields,
// never its message or response (those can echo the recipient).
describe('mailErrorFields', () => {
  it('keeps name, code, responseCode and command', () => {
    const err = Object.assign(new Error('x'), { code: 'EAUTH', responseCode: 535, command: 'AUTH LOGIN' })
    expect(mailErrorFields(err)).toEqual({ name: 'Error', code: 'EAUTH', responseCode: 535, command: 'AUTH LOGIN' })
  })

  it('never carries the message or the response, which can echo an address', () => {
    const err = Object.assign(new Error('550 <a@example.org> denied'), { response: '550 <a@example.org> denied' })
    expect(JSON.stringify(mailErrorFields(err))).not.toContain('example.org')
  })

  it('drops fields that are not plain tokens', () => {
    const err = Object.assign(new Error('x'), {
      code: 'a@example.org', responseCode: 'a@example.org', command: 'RCPT TO:<a@example.org>',
    })
    expect(mailErrorFields(err)).toEqual({ name: 'Error' })
  })

  it('names a non-Error by its type only', () => {
    expect(mailErrorFields('a@example.org')).toEqual({ name: 'string' })
  })
})
