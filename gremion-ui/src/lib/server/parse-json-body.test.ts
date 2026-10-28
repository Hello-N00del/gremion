import { describe, it, expect } from 'vitest'
import { parseJsonBody } from './parse-json-body'

const req = (body: string, headers: Record<string, string> = {}) =>
  new Request('https://app.example.org/api/x', { method: 'POST', body, headers })

async function status(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { status?: number }).status ?? -1
  }
}

describe('parseJsonBody', () => {
  it('parses application/json', async () => {
    expect(await parseJsonBody(req('{"a":1}', { 'content-type': 'application/json' }))).toEqual({ a: 1 })
  })
  it('accepts a charset parameter and +json types', async () => {
    expect(await parseJsonBody(req('{"a":1}', { 'content-type': 'application/json; charset=utf-8' }))).toEqual({ a: 1 })
    expect(await parseJsonBody(req('{"a":1}', { 'content-type': 'application/merge-patch+json' }))).toEqual({ a: 1 })
  })
  it('returns null for malformed JSON under application/json', async () => {
    expect(await parseJsonBody(req('{nope', { 'content-type': 'application/json' }))).toBeNull()
  })
  it.each([['text/plain'], ['text/plain;charset=UTF-8'], ['application/x-www-form-urlencoded'], ['multipart/form-data; boundary=x']])(
    'refuses a JSON body sent as %s with 415',
    async (ct) => {
      expect(await status(parseJsonBody(req('{"a":1}', { 'content-type': ct })))).toBe(415)
    },
  )
  it('refuses a body with no Content-Type with 415', async () => {
    const r = new Request('https://app.example.org/api/x', { method: 'POST', body: new Blob(['{"a":1}']) })
    r.headers.delete('content-type')
    expect(await status(parseJsonBody(r))).toBe(415)
  })
})
