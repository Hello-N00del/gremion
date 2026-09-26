// Request media types the spec declares. A declared operation must never
// answer 415 to a request that matches its own spec: a +json type is parsed as
// JSON (under the same ceiling and poisoning rules as application/json), and a
// type the template cannot parse refuses to boot, named, instead of booting a
// route that rejects every conforming request.
import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createService, PROBLEM_CONTENT_TYPE, PROBLEM_TYPES, ServiceBootError, type OperationHandler } from '../src/index.ts'
import { fixtureHandlers, fixtureSpec, type FixtureSpec } from './helpers.ts'

const apps: FastifyInstance[] = []
afterEach(async () => {
  while (apps.length) await apps.pop()!.close()
})

const WIDGET = '/widgets/00000000-0000-4000-8000-000000000001'
const noContent: OperationHandler = async (_request, reply) => reply.code(204).send()

function withRequestBody(mediaType: string, schema: object = { type: 'object', properties: { name: { type: 'string' } } }): FixtureSpec {
  const spec = fixtureSpec()
  spec.paths['/widgets/{widgetId}'].patch = {
    operationId: 'patchWidget',
    requestBody: { required: true, content: { [mediaType]: { schema } } },
    responses: { '204': { description: 'Patched' } },
  }
  return spec
}

function service(spec: FixtureSpec, uploadCeilingBytes?: number): FastifyInstance {
  const app = createService({
    spec,
    handlers: { ...fixtureHandlers(), patchWidget: noContent },
    config: uploadCeilingBytes === undefined ? {} : { uploadCeilingBytes },
  })
  apps.push(app)
  return app
}

describe('a declared +json request media type is parsed as JSON', () => {
  it('application/merge-patch+json: a valid body reaches the handler, an invalid one is a 400 problem', async () => {
    const app = service(withRequestBody('application/merge-patch+json'))
    const headers = { 'content-type': 'application/merge-patch+json' }
    const ok = await app.inject({ method: 'PATCH', url: WIDGET, headers, payload: '{"name":"x"}' })
    expect(ok.statusCode, ok.body).toBe(204)
    const withCharset = await app.inject({
      method: 'PATCH',
      url: WIDGET,
      headers: { 'content-type': 'application/merge-patch+json; charset=utf-8' },
      payload: '{"name":"x"}',
    })
    expect(withCharset.statusCode, withCharset.body).toBe(204)
    const bad = await app.inject({ method: 'PATCH', url: WIDGET, headers, payload: '{"name":5}' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().type).toBe(PROBLEM_TYPES.validation)
  })

  it('keeps the JSON parser rules: malformed JSON and __proto__ are 400, not parsed', async () => {
    const app = service(withRequestBody('application/merge-patch+json'))
    const headers = { 'content-type': 'application/merge-patch+json' }
    expect((await app.inject({ method: 'PATCH', url: WIDGET, headers, payload: '{"name":' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: WIDGET, headers, payload: '{"__proto__":{"x":1}}' })).statusCode).toBe(400)
  })

  it('is bounded by the same ceiling, with the same typed 413', async () => {
    const app = service(withRequestBody('application/merge-patch+json'), 64)
    const res = await app.inject({
      method: 'PATCH',
      url: WIDGET,
      headers: { 'content-type': 'application/merge-patch+json' },
      payload: JSON.stringify({ name: 'x'.repeat(200) }),
    })
    expect(res.statusCode).toBe(413)
    expect(String(res.headers['content-type'])).toContain(PROBLEM_CONTENT_TYPE)
    expect(res.json()).toMatchObject({ type: PROBLEM_TYPES.payloadTooLarge, limitBytes: 64 })
  })

  it('an undeclared +json type on the same route is still refused (415), not parsed', async () => {
    const app = service(withRequestBody('application/merge-patch+json'))
    const res = await app.inject({
      method: 'PATCH',
      url: WIDGET,
      headers: { 'content-type': 'application/vnd.other+json' },
      payload: '{"name":"x"}',
    })
    expect(res.statusCode).toBe(415)
  })
})

describe('a declared request media type the template cannot parse refuses to boot, named', () => {
  it.each(['application/octet-stream', 'application/x-www-form-urlencoded', 'application/*', '*/*'])('%s', (mediaType) => {
    const spec = withRequestBody(mediaType, { type: 'string' })
    expect(() => service(spec)).toThrow(ServiceBootError)
    expect(() => service(spec)).toThrow(new RegExp(`PATCH /widgets/\\{widgetId\\}.*${mediaType.replace(/[*+/]/g, '\\$&')}`))
  })

  it('the supported set boots: application/json, text/plain, multipart/form-data, any +json', () => {
    for (const mediaType of ['application/json', 'text/plain', 'multipart/form-data', 'application/problem+json']) {
      expect(() => service(withRequestBody(mediaType, mediaType === 'text/plain' ? { type: 'string' } : { type: 'object' })), mediaType).not.toThrow()
    }
  })
})
