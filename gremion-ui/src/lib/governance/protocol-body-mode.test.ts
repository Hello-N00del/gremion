import { describe, it, expect } from 'vitest'
import { protocolBodyMode } from './protocol-body-mode'

const base = { isEditable: true, isAdmin: true, hasWopiToken: false, hasDraftDocument: false }

describe('protocolBodyMode', () => {
  it('files-on protocol with an ODT and a failed wopi token gets NO editor', () => {
    expect(protocolBodyMode({ ...base, hasDraftDocument: true })).toBe('unavailable')
  })
  it('collabora when a wopi token exists', () => {
    expect(protocolBodyMode({ ...base, hasWopiToken: true, hasDraftDocument: true })).toBe('collabora')
  })
  it('in-app editor only when there is no ODT', () => {
    expect(protocolBodyMode(base)).toBe('in-app')
  })
  it('non-admin and non-editable are read-only', () => {
    expect(protocolBodyMode({ ...base, isAdmin: false })).toBe('readonly')
    expect(protocolBodyMode({ ...base, isEditable: false, hasDraftDocument: true })).toBe('readonly')
  })
})
