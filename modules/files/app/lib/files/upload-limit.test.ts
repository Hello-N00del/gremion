import { describe, it, expect } from 'vitest'
import { MAX_UPLOAD_BYTES, isUploadTooLarge } from './upload-limit'

describe('upload limit', () => {
  it('is 100 MiB: the same number as BODY_SIZE_LIMIT=100M of the app container', () => {
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024)
  })

  it('accepts a file of exactly the limit and refuses one byte more', () => {
    expect(isUploadTooLarge(MAX_UPLOAD_BYTES)).toBe(false)
    expect(isUploadTooLarge(MAX_UPLOAD_BYTES + 1)).toBe(true)
  })

  it('accepts the sizes the chunk path used to take (a 12 MB scan)', () => {
    expect(isUploadTooLarge(12 * 1024 * 1024)).toBe(false)
    expect(isUploadTooLarge(0)).toBe(false)
  })
})
