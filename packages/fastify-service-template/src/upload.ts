// Upload-limit enforcement that cannot be bypassed by a handler.
//
// @fastify/multipart with `throwFileSizeLimit: true` throws a 413 only on
// some paths (toBuffer(), the parts() iterator's next step). A handler that
// iterates `part.file` directly sees the stream simply END at the limit, with
// `part.file.truncated === true` and no error: a truncated file that a careless
// handler would store and answer 2xx for. Two layers close that:
//
//   1. armUploadLimit (a preHandler on every multipart operation) wraps
//      request.file()/files()/parts() so each file stream is DESTROYED with the
//      plugin's RequestFileTooLargeError (FST_REQ_FILE_TOO_LARGE) the moment
//      busboy reports the limit. Iterating it throws; the error handler maps
//      it to the typed 413.
//   2. an onSend hook (service.ts, via uploadLimitWasHit) turns any non-error response
//      to a request whose file hit the limit into that same 413, in case a
//      handler caught the error and answered success anyway.
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'

const LIMIT_HIT = Symbol('gremion.uploadLimitHit')

interface FilePart {
  type?: string
  file?: Readable & { truncated?: boolean }
}

type Tracked = FastifyRequest & { [LIMIT_HIT]?: boolean }

// The three stream-mode accessors @fastify/multipart decorates the request
// with, typed loosely: they are wrapped, not called with typed options here.
interface MultipartMethods {
  file: (...args: unknown[]) => Promise<FilePart | undefined>
  files: (...args: unknown[]) => AsyncIterable<FilePart>
  parts: (...args: unknown[]) => AsyncIterable<FilePart>
}

function tooLarge(request: FastifyRequest): Error {
  const errors = (request.server as unknown as { multipartErrors: { RequestFileTooLargeError: new () => Error } })
    .multipartErrors
  return new errors.RequestFileTooLargeError()
}

function armPart(request: Tracked, part: FilePart | undefined): void {
  if (!part || !part.file || typeof part.file.once !== 'function') return
  const file = part.file
  file.once('limit', () => {
    request[LIMIT_HIT] = true
    file.destroy(tooLarge(request))
  })
}

export function armUploadLimit(request: FastifyRequest, _reply: FastifyReply): void {
  const tracked = request as Tracked
  const req = request as unknown as MultipartMethods
  if (typeof req.file !== 'function') return
  const file = req.file
  const files = req.files
  const parts = req.parts
  req.file = async function (...args: unknown[]) {
    const part = await file.apply(this, args)
    armPart(tracked, part)
    return part
  }
  const wrapIterator = (source: (...a: unknown[]) => AsyncIterable<FilePart>) =>
    async function* (this: unknown, ...args: unknown[]) {
      for await (const part of source.apply(this, args)) {
        if (part && part.type === 'file') armPart(tracked, part)
        yield part
      }
    }
  req.files = wrapIterator(files)
  req.parts = wrapIterator(parts)
}

export function uploadLimitWasHit(request: FastifyRequest): boolean {
  return (request as Tracked)[LIMIT_HIT] === true
}
