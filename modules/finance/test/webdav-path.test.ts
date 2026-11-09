// test/webdav-path.test.ts — the Nextcloud WebDAV path primitive (#383 Lane E, (d)).
//
// The receipt-storage backend addresses Nextcloud over WebDAV. Path building must
// apply the SAME traversal guard the native oracle uses (gremion-ui/.../files/
// webdav-path.ts) so a receipt filename can never escape the per-user namespace —
// ported verbatim, with the SvelteKit `error()` swapped for a typed WebdavPathError
// the leaf's HTTP layer maps to 400.

import { describe, it, expect } from 'vitest'
import {
  sanitizeRelPath,
  buildWebdavPath,
  WebdavPathError,
} from '../src/nextcloud/webdav-path.ts'

describe('nextcloud/webdav-path — sanitizeRelPath', () => {
  it('passes a normal relative path through, stripping leading slashes', () => {
    expect(sanitizeRelPath('/finance/receipts/a.pdf')).toBe('finance/receipts/a.pdf')
    expect(sanitizeRelPath('a/b/c.png')).toBe('a/b/c.png')
  })

  it('rejects a literal ".." traversal segment', () => {
    expect(() => sanitizeRelPath('a/../../etc/passwd')).toThrow(WebdavPathError)
  })

  it('collapses a doubly/over-encoded traversal then rejects it', () => {
    // "%252e%252e%252f" → decode → "%2e%2e%2f" → decode → "../"
    expect(() => sanitizeRelPath('%252e%252e%252fsecret')).toThrow(WebdavPathError)
  })

  it('rejects a residual "%" that a downstream decoder could turn into ".."', () => {
    expect(() => sanitizeRelPath('a/%2e%2')).toThrow(WebdavPathError)
  })

  it('rejects a malformed percent-escape', () => {
    expect(() => sanitizeRelPath('a/%zz')).toThrow(WebdavPathError)
  })

  // fetch's URL parser reads a backslash as `/` and deletes tab and newline, so
  // each of these becomes a `..` segment only after the `..` check.
  it('rejects a backslash, a raw or encoded tab or newline, and any other control character', () => {
    const BS = String.fromCharCode(92)
    for (const p of [`..${BS}x`, `a${BS}b`, '.\n./x', '.%0a./x', '%2e%09%2e/x', 'a\u0000b', 'a\u007fb', 'a%250ab']) {
      expect(() => sanitizeRelPath(p), JSON.stringify(p)).toThrow(WebdavPathError)
    }
  })
})

describe('nextcloud/webdav-path — buildWebdavPath', () => {
  it('builds the /remote.php/dav/files/<user>/<path> fragment', () => {
    expect(buildWebdavPath('stura', 'finance/r.pdf')).toBe(
      '/remote.php/dav/files/stura/finance/r.pdf',
    )
  })

  it('URL-encodes an email-style username', () => {
    expect(buildWebdavPath('a@b.de', 'x.pdf')).toBe('/remote.php/dav/files/a%40b.de/x.pdf')
  })

  it('propagates the traversal guard (a ".." path throws)', () => {
    expect(() => buildWebdavPath('stura', '../../escape')).toThrow(WebdavPathError)
  })
})
