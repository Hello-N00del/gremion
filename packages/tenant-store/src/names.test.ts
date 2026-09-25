import { describe, expect, it } from 'vitest'
import { assertTargetMatches, envResolveTarget, isUuidV7, tenantModuleDbName } from './names.js'

const A = '01928f4e-8c3b-7a51-9d2e-3f4a5b6c7d8e'
const V4 = '3b241101-e2bb-4255-8caf-4136c566a962'

describe('tenantModuleDbName', () => {
  it('is t_<uuid hex32>__<module>', () => {
    expect(tenantModuleDbName(A, 'calendar')).toBe('t_01928f4e8c3b7a519d2e3f4a5b6c7d8e__calendar')
  })

  it('stays inside [a-z0-9_] and 63 bytes for the longest module id it accepts', () => {
    const name = tenantModuleDbName(A, 'a'.repeat(27))
    expect(name).toMatch(/^[a-z0-9_]+$/)
    expect(Buffer.byteLength(name)).toBe(63)
    expect(() => tenantModuleDbName(A, 'a'.repeat(28))).toThrow(/63/)
  })

  it.each([
    ['uppercase', A.toUpperCase()],
    ['a version-4 id', V4],
    ['no dashes', A.replaceAll('-', '')],
    ['an injection', `${A}"; DROP DATABASE x; --`],
    ['empty', ''],
  ])('refuses a tenant id that is not a canonical UUIDv7: %s', (_label, id) => {
    expect(() => tenantModuleDbName(id, 'calendar')).toThrow(/tenant id/)
  })

  it.each([
    ['uppercase', 'Calendar'],
    ['a double underscore (the separator)', 'cal__endar'],
    ['a trailing underscore', 'calendar_'],
    ['a leading digit', '1calendar'],
    ['a quote', 'cal"endar'],
    ['a dash', 'cal-endar'],
    ['a space', 'cal endar'],
    ['non-ASCII', 'kalendär'],
    ['empty', ''],
  ])('refuses a module id outside [a-z][a-z0-9]*(_[a-z0-9]+)*: %s', (_label, m) => {
    expect(() => tenantModuleDbName(A, m)).toThrow(/module id/)
  })
})

describe('isUuidV7', () => {
  it('accepts version 7 with the RFC 9562 variant only', () => {
    expect(isUuidV7(A)).toBe(true)
    expect(isUuidV7(V4)).toBe(false)
    expect(isUuidV7('01928f4e-8c3b-7a51-cd2e-3f4a5b6c7d8e')).toBe(false) // variant 110
  })
})

describe('envResolveTarget (Q2 default resolver)', () => {
  it('reads GREMION_<MODULE>_PG_URL and replaces the database name', () => {
    const resolve = envResolveTarget({ GREMION_CALENDAR_PG_URL: 'postgres://u:p@db.invalid:5432/postgres?sslmode=disable' })
    const { url } = resolve(A, 'calendar')
    const u = new URL(url)
    expect(u.pathname).toBe('/t_01928f4e8c3b7a519d2e3f4a5b6c7d8e__calendar')
    expect(u.searchParams.get('sslmode')).toBe('disable')
  })

  it('upper-cases a multi-word module id into the variable name', () => {
    const resolve = envResolveTarget({ GREMION_PUBLIC_PORTAL_PG_URL: 'postgres://u@h/x' })
    expect(resolve(A, 'public_portal').url).toContain('__public_portal')
  })

  it('throws, naming the variable, when it is unset', () => {
    expect(() => envResolveTarget({})(A, 'calendar')).toThrow(/GREMION_CALENDAR_PG_URL/)
  })

  it('refuses a non-postgres scheme and an unparseable url', () => {
    expect(() => envResolveTarget({ GREMION_CALENDAR_PG_URL: 'http://h/x' })(A, 'calendar')).toThrow(/scheme/)
    expect(() => envResolveTarget({ GREMION_CALENDAR_PG_URL: 'not a url' })(A, 'calendar')).toThrow(/parse/)
  })

  it('validates both ids before it reads the environment', () => {
    expect(() => envResolveTarget({})(A, 'x"y')).toThrow(/module id/)
  })
})

describe('assertTargetMatches', () => {
  const name = tenantModuleDbName(A, 'calendar')
  it('passes the exact database, with the allowed TLS / session parameters', () => {
    expect(() => assertTargetMatches(`postgres://u@h/${name}`, name)).not.toThrow()
    expect(() => assertTargetMatches(`postgresql://u@h:6432/${name}?sslmode=verify-full&application_name=x`, name)).not.toThrow()
  })
  it.each([
    ['another database', 'postgres://u@h/t_other__calendar'],
    ['a database query override', `postgres://u@h/${name}?database=postgres`],
    ['a dbname query override', `postgres://u@h/${name}?dbname=postgres`],
    ['a db query override', `postgres://u@h/${name}?db=postgres`],
    ['an options override', `postgres://u@h/${name}?options=-c%20search_path%3Dx`],
    ['a percent-encoded path', `postgres://u@h/${encodeURIComponent(name + '/x')}`],
    ['a startup-parameter override (search_path)', `postgres://u@h/${name}?search_path=evil`],
    ['a role override', `postgres://u@h/${name}?role=postgres`],
    ['a non-postgres scheme', `http://u@h/${name}`],
  ])('refuses %s', (_label, url) => {
    expect(() => assertTargetMatches(url, name)).toThrow(/target/)
  })
})
