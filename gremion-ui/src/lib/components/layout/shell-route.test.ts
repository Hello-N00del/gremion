import { describe, expect, it } from 'vitest'
import { isShellPath } from './shell-route'

describe('isShellPath', () => {
  it('keeps the kernel bare pages shell-less', () => {
    for (const p of ['/auth/login', '/legal/impressum', '/setup', '/setup/health']) expect(isShellPath(p)).toBe(false)
  })

  it('gives ordinary pages the shell', () => {
    for (const p of ['/', '/files', '/files/Protokolle', '/calendar']) expect(isShellPath(p)).toBe(true)
  })

  it('drops the shell only for a route a module declared bare, and only at a path boundary', () => {
    const bare = ['/files/edit']
    expect(isShellPath('/files/edit', bare)).toBe(false)
    expect(isShellPath('/files/edit/a/b.odt', bare)).toBe(false)
    expect(isShellPath('/files/editing', bare)).toBe(true)
    expect(isShellPath('/files', bare)).toBe(true)
    // Without a declaration the kernel does not know the route: it keeps the shell.
    expect(isShellPath('/files/edit/a.odt')).toBe(true)
  })
})
