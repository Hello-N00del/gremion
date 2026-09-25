// T7: the ceiling is one validated constant. Bad config refuses to boot with a
// named error (never a silent fallback to the default); an override moves the
// 413 boundary for multipart files AND non-multipart bodies alike. Also pins
// both layers of the no-truncation guarantee (src/upload.ts).
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  createService,
  DEFAULT_UPLOAD_CEILING_BYTES,
  getUploadCeilingBytes,
  InvalidUploadCeilingError,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPES,
  resolveUploadCeiling,
  type OperationHandler,
} from '../src/index.ts'
import { fixtureHandlers, fixtureSpec } from './helpers.ts'

const MIB = 1_048_576
const apps: FastifyInstance[] = []
afterEach(async () => {
  while (apps.length) await apps.pop()!.close()
})

const hashingUpload: OperationHandler = async (request, reply) => {
  const part = await (request as any).file()
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of part.file) {
    hash.update(chunk)
    bytes += chunk.length
  }
  reply.code(201)
  return { sha256: hash.digest('hex'), bytes }
}

function service(uploadCeilingBytes: unknown, uploadFile: OperationHandler = hashingUpload): FastifyInstance {
  const app = createService({ spec: fixtureSpec(), handlers: { ...fixtureHandlers(), uploadFile }, config: { uploadCeilingBytes } })
  apps.push(app)
  return app
}

function multipart(size: number) {
  const boundary = 'gremion-test-boundary'
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.alloc(size, 0x61),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload }
}

function expectTyped413(res: { statusCode: number; headers: Record<string, unknown>; json: () => any }, limit: number) {
  expect(res.statusCode).toBe(413)
  expect(String(res.headers['content-type'])).toContain(PROBLEM_CONTENT_TYPE)
  expect(res.json()).toMatchObject({ type: PROBLEM_TYPES.payloadTooLarge, status: 413, limitBytes: limit })
}

describe('T7: ceiling config validation', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -1],
    ['fraction', 1.5],
    ['beyond safe integer', 2 ** 53],
    ['empty string', ''],
    ['non-numeric string', 'abc'],
    ['unit suffix', '50MB'],
    ['exponent string', '1e6'],
    ['negative string', '-5'],
    ['string zero', '0'],
    ['null', null],
    ['boolean', true],
    ['object', {}],
  ])('%s refuses to boot with a named error', (_label, value) => {
    expect(() => service(value)).toThrow(InvalidUploadCeilingError)
    try {
      service(value)
    } catch (e) {
      expect((e as InvalidUploadCeilingError).code).toBe('GREMION_INVALID_UPLOAD_CEILING')
      expect((e as Error).message).toMatch(/uploadCeilingBytes must be a positive safe integer/)
    }
  })

  it('never falls back: resolveUploadCeiling returns the default only for undefined', () => {
    expect(resolveUploadCeiling(undefined)).toBe(DEFAULT_UPLOAD_CEILING_BYTES)
    expect(resolveUploadCeiling(1)).toBe(1)
    expect(resolveUploadCeiling('1048576')).toBe(MIB)
  })

  it('unset config = the 50 MiB default', () => {
    expect(getUploadCeilingBytes(service(undefined))).toBe(52_428_800)
  })
})

describe('T7: an override moves the 413 boundary', () => {
  it.each([
    ['a number', MIB],
    ['a decimal string (env var)', String(MIB)],
  ])('1 MiB as %s: a 1 MiB file passes, 1 MiB + 1 is a typed 413', async (_label, configured) => {
    const app = service(configured)
    expect(getUploadCeilingBytes(app)).toBe(MIB)
    const ok = await app.inject({ method: 'POST', url: '/uploads', ...multipart(MIB) })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().bytes).toBe(MIB)
    expectTyped413(await app.inject({ method: 'POST', url: '/uploads', ...multipart(MIB + 1) }), MIB)
  })

  it('the same ceiling bounds a non-multipart (JSON) body with the same typed 413', async () => {
    const app = service(1024)
    const small = await app.inject({ method: 'POST', url: '/widgets', payload: { name: 'x'.repeat(100) } })
    expect(small.statusCode, small.body).toBe(201)
    const big = await app.inject({
      method: 'POST',
      url: '/widgets',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x'.repeat(2048) }),
    })
    expectTyped413(big, 1024)
  })
})

describe('no truncation: a file over the ceiling never yields a success', () => {
  it('layer 1: iterating the file stream past the ceiling throws (it does not just end)', async () => {
    let iterationError: unknown
    const app = service(1024, async (request, reply) => {
      const part = await (request as any).file()
      try {
        for await (const _chunk of part.file) {
          // consume
        }
      } catch (e) {
        iterationError = e
        throw e
      }
      reply.code(201)
      return { sha256: '0'.repeat(64), bytes: 0 }
    })
    expectTyped413(await app.inject({ method: 'POST', url: '/uploads', ...multipart(4096) }), 1024)
    expect((iterationError as { code?: string } | undefined)?.code).toBe('FST_REQ_FILE_TOO_LARGE')
  })

  it.each([
    ['file()', 'file'],
    ['files()', 'files'],
    ['parts()', 'parts'],
  ])('a handler cannot raise the ceiling per call via %s({ limits: { fileSize } })', async (_label, accessor) => {
    const app = service(1024, async (request, reply) => {
      const opts = { limits: { fileSize: 10 * MIB }, throwFileSizeLimit: false }
      const req = request as any
      const part = accessor === 'file' ? await req.file(opts) : (await req[accessor](opts)[Symbol.asyncIterator]().next()).value
      let bytes = 0
      for await (const chunk of part.file) bytes += chunk.length
      reply.code(201)
      return { sha256: '0'.repeat(64), bytes }
    })
    expectTyped413(await app.inject({ method: 'POST', url: '/uploads', ...multipart(4096) }), 1024)
  })

  it('a handler may still LOWER the limit per call', async () => {
    const app = service(MIB, async (request, reply) => {
      const part = await (request as any).file({ limits: { fileSize: 100 } })
      let bytes = 0
      for await (const chunk of part.file) bytes += chunk.length
      reply.code(201)
      return { sha256: '0'.repeat(64), bytes }
    })
    const res = await app.inject({ method: 'POST', url: '/uploads', ...multipart(200) })
    expect(res.statusCode).toBe(413)
  })

  it('layer 2: a handler that swallows the error and answers 201 is still answered 413', async () => {
    const app = service(1024, async (request, reply) => {
      const part = await (request as any).file()
      let bytes = 0
      try {
        for await (const chunk of part.file) bytes += chunk.length
      } catch {
        // a careless handler: ignore and report success with what it got
      }
      reply.code(201)
      return { sha256: '0'.repeat(64), bytes }
    })
    expectTyped413(await app.inject({ method: 'POST', url: '/uploads', ...multipart(4096) }), 1024)
  })
})
