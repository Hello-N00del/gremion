// @vitest-environment node
import { afterEach, describe, expect, test } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import {
  TENANT_MARKER_TYPE,
  archiveAliasLocalpart,
  currentArchiveAliasLocalpart,
  currentArchiveAliasPrefix,
  currentUnitAliasLocalpart,
  currentMatrixLocalpart,
  displayUsername,
  escapeUsername,
  matrixIdentityMode,
  matrixLocalpart,
  stripTenantPrefix,
  unitAliasLocalpart,
  unitNameSlug,
} from './matrix-namespace'
import { aliasLocalpart } from './provisioning/matrix-subsystem'

const tenant = (slug: string): TenantContext => ({ id: `tid-${slug}`, slug }) as unknown as TenantContext

afterEach(() => {
  delete process.env.MATRIX_IDENTITY
})

describe('matrixLocalpart', () => {
  test('is the slug, a dot and the username', () => {
    expect(matrixLocalpart('acme', 'alice')).toBe('acme.alice')
    expect(matrixLocalpart('acme', 'max.mustermann')).toBe('acme.max.mustermann')
  })

  test('encodes every character outside the Matrix localpart set as _hh of its UTF-8 bytes', () => {
    expect(matrixLocalpart('acme', 'max@example.org')).toBe('acme.max_40example.org')
    expect(matrixLocalpart('acme', 'Ä')).toBe('acme._c3_84')
    expect(matrixLocalpart('acme', 'a b')).toBe('acme.a_20b')
  })

  test('keeps . = / and - as they are', () => {
    expect(escapeUsername('a.b=c/d-e')).toBe('a.b=c/d-e')
  })

  test('encodes the underscore itself, so a literal _40 in a username cannot read as an encoded @', () => {
    expect(escapeUsername('hans_dampf')).toBe('hans_5fdampf')
    expect(escapeUsername('max_40example.org')).not.toBe(escapeUsername('max@example.org'))
  })

  test('displayUsername undoes it for every shape of username, underscore and _hh look-alikes included', () => {
    for (const username of ['alice', 'max.mustermann', 'max@example.org', 'hans_dampf', 'max_40example.org', 'Ärztin', 'a b', 'x_5f40', 'a=b/c-d']) {
      expect(displayUsername('acme', matrixLocalpart('acme', username))).toBe(username)
    }
  })

  test('the same username in two customers gives two different localparts', () => {
    expect(matrixLocalpart('acme', 'alice')).not.toBe(matrixLocalpart('beta', 'alice'))
  })

  test('a dotted username of one customer never equals the plain username of another: the first dot splits slug from username', () => {
    // slugs carry no dot, so the first dot is always the separator
    expect(matrixLocalpart('a', 'b.alice')).toBe('a.b.alice')
    expect(matrixLocalpart('a-b', 'alice')).toBe('a-b.alice')
    expect(matrixLocalpart('a', 'b.alice')).not.toBe(matrixLocalpart('a-b', 'alice'))
    const split = (lp: string) => [lp.slice(0, lp.indexOf('.')), lp.slice(lp.indexOf('.') + 1)]
    expect(split(matrixLocalpart('a', 'b.alice'))).toEqual(['a', 'b.alice'])
  })

  test('refuses a slug the customer registry cannot have produced, and an empty username', () => {
    for (const slug of ['', 'A', 'a.b', '1a', 'a--b', '-a', 'a-', 'a b']) {
      expect(() => matrixLocalpart(slug, 'alice'), `slug ${JSON.stringify(slug)}`).toThrow(/slug/i)
    }
    expect(() => matrixLocalpart('acme', '')).toThrow(/username/i)
  })
})

describe('unitAliasLocalpart', () => {
  test('is stura. slug . the unit name slug of today', () => {
    expect(unitAliasLocalpart('acme', 'Vorstand')).toBe('stura.acme.vorstand')
    expect(unitAliasLocalpart('acme', 'Ältestenrat & Co.')).toBe('stura.acme.aeltestenrat-co')
  })

  test('uses the same name slug as the legacy alias, so the two differ only in their prefix', () => {
    for (const name of ['Vorstand', 'Fachschaftsrat Mathe', 'Öffentlichkeitsarbeit', 'Café Müller']) {
      expect(aliasLocalpart(name)).toBe(`stura-${unitNameSlug(name)}`)
      expect(unitAliasLocalpart('acme', name)).toBe(`stura.acme.${unitNameSlug(name)}`)
    }
  })

  test('two customers with a unit of the same name get two aliases', () => {
    expect(unitAliasLocalpart('acme', 'Vorstand')).not.toBe(unitAliasLocalpart('beta', 'Vorstand'))
  })

  test('refuses an invalid slug', () => {
    expect(() => unitAliasLocalpart('a.b', 'Vorstand')).toThrow(/slug/i)
  })
})

describe('displaying an identity', () => {
  test('the prefix of the own slug is stripped, nothing else is', () => {
    expect(stripTenantPrefix('acme.alice', 'acme')).toBe('alice')
    expect(stripTenantPrefix('acme.max.mustermann', 'acme')).toBe('max.mustermann')
    expect(stripTenantPrefix('beta.alice', 'acme')).toBe('beta.alice')
  })

  test('a legacy id such as max.mustermann is displayed unchanged, whatever its first segment is', () => {
    expect(displayUsername('acme', 'max.mustermann')).toBe('max.mustermann')
    expect(displayUsername('max', 'max.mustermann')).toBe('mustermann') // only when the slug IS the first segment of the own tenant
  })
})

describe('the tenant marker', () => {
  test('is the state event type the rooms carry', () => {
    expect(TENANT_MARKER_TYPE).toBe('org.gremion.tenant')
  })
})

describe('matrixIdentityMode', () => {
  test('unset, empty and legacy are legacy', () => {
    expect(matrixIdentityMode()).toBe('legacy')
    process.env.MATRIX_IDENTITY = ''
    expect(matrixIdentityMode()).toBe('legacy')
    process.env.MATRIX_IDENTITY = 'legacy'
    expect(matrixIdentityMode()).toBe('legacy')
  })

  test('namespaced is namespaced', () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    expect(matrixIdentityMode()).toBe('namespaced')
  })

  test('any other value fails closed instead of falling back to legacy', () => {
    process.env.MATRIX_IDENTITY = 'Namespaced'
    expect(() => matrixIdentityMode()).toThrow(/MATRIX_IDENTITY/)
  })
})

describe('currentMatrixLocalpart', () => {
  test('legacy: the username, and no tenant context is read', () => {
    expect(currentMatrixLocalpart('max.mustermann')).toBe('max.mustermann')
  })

  test('namespaced: the slug of the request tenant in front of the username', () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    expect(runWithTenant(tenant('acme'), () => currentMatrixLocalpart('alice'))).toBe('acme.alice')
    expect(runWithTenant(tenant('beta'), () => currentMatrixLocalpart('alice'))).toBe('beta.alice')
  })

  test('namespaced outside a tenant scope throws (no ambient customer)', () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    expect(() => currentMatrixLocalpart('alice')).toThrow(/No tenant context/)
  })
})

describe('the alias of a unit room and of its archive, under the identity switch', () => {
  test('archiveAliasLocalpart carries the customer: stura-archiv.<slug>.<unit>-<ts>', () => {
    expect(archiveAliasLocalpart('acme', 'Vorstand', '202611251200')).toBe('stura-archiv.acme.vorstand-202611251200')
    expect(archiveAliasLocalpart('acme', 'Vorstand', '202611251200')).not.toBe(archiveAliasLocalpart('beta', 'Vorstand', '202611251200'))
    expect(() => archiveAliasLocalpart('Bad.Slug', 'Vorstand', '202611251200')).toThrow(/slug/)
  })

  test('legacy: exactly the aliases of the legacy namespace, no tenant context read', () => {
    expect(currentUnitAliasLocalpart('Finanzen & Büro')).toBe(aliasLocalpart('Finanzen & Büro'))
    expect(currentUnitAliasLocalpart('Vorstand')).toBe('stura-vorstand')
    expect(currentArchiveAliasLocalpart('Vorstand', '202611251200')).toBe('stura-archiv-vorstand-202611251200')
    expect(currentArchiveAliasPrefix()).toBe('#stura-archiv-')
  })

  test('namespaced: the unit and archive aliases of the request customer, and its own archive prefix', () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    runWithTenant(tenant('acme'), () => {
      expect(currentUnitAliasLocalpart('Vorstand')).toBe('stura.acme.vorstand')
      expect(currentArchiveAliasLocalpart('Vorstand', '202611251200')).toBe('stura-archiv.acme.vorstand-202611251200')
      expect(currentArchiveAliasPrefix()).toBe('#stura-archiv.acme.')
      expect(`#${currentArchiveAliasLocalpart('Vorstand', '202611251200')}:srv`.startsWith(currentArchiveAliasPrefix())).toBe(true)
    })
    runWithTenant(tenant('beta'), () => {
      expect('#stura-archiv.acme.vorstand-202611251200:srv'.startsWith(currentArchiveAliasPrefix())).toBe(false)
    })
  })

  test('namespaced outside a tenant scope throws (no ambient customer)', () => {
    process.env.MATRIX_IDENTITY = 'namespaced'
    expect(() => currentUnitAliasLocalpart('Vorstand')).toThrow(/No tenant context/)
  })
})
