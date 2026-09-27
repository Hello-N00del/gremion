// The platform upload ceiling (TRD-213). ONE constant feeds both limits:
// Fastify's `bodyLimit` (non-multipart bodies) and @fastify/multipart's
// `limits.fileSize` (file payload). "50 MB" is read as 50 MiB of FILE
// payload; the multipart envelope does not count against it (brief §5 Q4,
// TRD "[A] provisional").
import { ServiceBootError } from './errors.ts'

export const DEFAULT_UPLOAD_CEILING_BYTES = 52_428_800 // 50 MiB = 50 * 1024 * 1024

export class InvalidUploadCeilingError extends ServiceBootError {
  override readonly code: string = 'GREMION_INVALID_UPLOAD_CEILING'

  constructor(value: unknown) {
    super(
      [
        `uploadCeilingBytes must be a positive safe integer (bytes); got ${describe(value)}. ` +
          'Leave it unset for the 50 MiB default; an invalid value never falls back to the default.',
      ],
      'invalid upload ceiling',
    )
    this.name = 'InvalidUploadCeilingError'
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  if (value === null) return 'null'
  return typeof value
}

/**
 * Resolve the configured ceiling. `undefined` (not configured) is the only
 * value that yields the default. A number must be a positive safe integer; a
 * string (an environment variable) must be plain decimal digits naming one.
 * Everything else — NaN, 0, negatives, fractions, '', '50MB', null — throws.
 */
export function resolveUploadCeiling(value: unknown): number {
  if (value === undefined) return DEFAULT_UPLOAD_CEILING_BYTES
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    n = Number(value)
  } else {
    throw new InvalidUploadCeilingError(value)
  }
  if (!Number.isSafeInteger(n) || n <= 0) throw new InvalidUploadCeilingError(value)
  return n
}
