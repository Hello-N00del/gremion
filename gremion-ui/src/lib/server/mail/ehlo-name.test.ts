import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('smtpEhloName', () => {
  const saved = process.env.PUBLIC_BASE_URL
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    if (saved === undefined) delete process.env.PUBLIC_BASE_URL
    else process.env.PUBLIC_BASE_URL = saved
  })

  it('returns the host name of PUBLIC_BASE_URL without a warning', async () => {
    process.env.PUBLIC_BASE_URL = 'https://app.example.test/'
    const { smtpEhloName } = await import('./ehlo-name')
    expect(smtpEhloName()).toBe('app.example.test')
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns once, naming PUBLIC_BASE_URL but not its value, when it is unset or unparsable', async () => {
    delete process.env.PUBLIC_BASE_URL
    const { smtpEhloName } = await import('./ehlo-name')
    expect(smtpEhloName()).toBeUndefined()
    process.env.PUBLIC_BASE_URL = 'not a url secret-marker'
    expect(smtpEhloName()).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    const line = warn.mock.calls[0]!.map(String).join(' ')
    expect(line).toContain('PUBLIC_BASE_URL')
    expect(line).not.toContain('secret-marker')
  })
})
