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
const PARTS = Symbol('gremion.uploadParts')

interface FilePart {
  type?: string
  file?: Readable & { truncated?: boolean }
}

type Tracked = FastifyRequest & { [LIMIT_HIT]?: boolean; [PARTS]?: FilePart[] }

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
  ;(request[PARTS] ??= []).push(part)
  const trip = () => {
    request[LIMIT_HIT] = true
    file.destroy(tooLarge(request))
  }
  // Busboy may have hit the limit (and emitted 'limit') before this runs, when
  // the whole body was already buffered: `truncated` is set before the event.
  if (file.truncated === true) trip()
  else file.once('limit', trip)
}

/**
 * @fastify/multipart deep-merges per-call options over the plugin's, so a
 * handler could pass `{ limits: { fileSize: <more> } }` (or turn
 * throwFileSizeLimit off) and raise the platform ceiling from handler code.
 * The ceiling moves only through validated config: a per-call fileSize is
 * clamped to it (a LOWER per-call limit is kept) and throwFileSizeLimit is
 * forced on.
 */
function clampOptions(args: unknown[], ceilingBytes: number): unknown[] {
  const [first, ...rest] = args
  const opts = first && typeof first === 'object' ? (first as Record<string, unknown>) : {}
  const limits = opts.limits && typeof opts.limits === 'object' ? (opts.limits as Record<string, unknown>) : {}
  const asked = limits.fileSize
  const fileSize = typeof asked === 'number' && Number.isSafeInteger(asked) && asked >= 0 && asked < ceilingBytes ? asked : ceilingBytes
  return [{ ...opts, limits: { ...limits, fileSize }, throwFileSizeLimit: true }, ...rest]
}

export function armUploadLimit(request: FastifyRequest, _reply: FastifyReply, ceilingBytes: number): void {
  const tracked = request as Tracked
  const req = request as unknown as MultipartMethods
  if (typeof req.file !== 'function') return
  const file = req.file
  const files = req.files
  const parts = req.parts
  req.file = async function (...args: unknown[]) {
    const part = await file.apply(this, clampOptions(args, ceilingBytes))
    armPart(tracked, part)
    return part
  }
  const wrapIterator = (source: (...a: unknown[]) => AsyncIterable<FilePart>) =>
    async function* (this: unknown, ...args: unknown[]) {
      for await (const part of source.apply(this, clampOptions(args, ceilingBytes))) {
        if (part && part.type === 'file') armPart(tracked, part)
        yield part
      }
    }
  req.files = wrapIterator(files)
  req.parts = wrapIterator(parts)
}

/** True if any file part of this request hit the ceiling (flag, or busboy's own truncated mark). */
export function uploadLimitWasHit(request: FastifyRequest): boolean {
  const tracked = request as Tracked
  return tracked[LIMIT_HIT] === true || (tracked[PARTS] ?? []).some((p) => p.file?.truncated === true)
}
