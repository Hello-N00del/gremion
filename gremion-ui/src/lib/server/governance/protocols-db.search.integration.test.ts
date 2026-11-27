// searchProtocols against a real Postgres (the command palette's minutes search): what the statement
// matches, as the database evaluates it. protocols-db.search.test.ts pins the pattern and the parameters
// with a stand-in; the behaviour of ILIKE / ESCAPE / regexp_replace / to_char is only proven here.
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db'
import { createOrgUnit } from './org-units-db'
import { createProtocol } from '../protocols/protocol-db'
import { searchProtocols } from './protocols-db'

async function seed(title: string, meetingDate: string, bodyHtml: string | null = null): Promise<string> {
  const unit = await createOrgUnit({
    name: `Gremium ${title}`, description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  const protocol = await createProtocol({ committeeId: unit.id, meetingDate, title, createdBy: 'chair-0' })
  if (bodyHtml !== null) await getDb()`UPDATE protocols SET body_html = ${bodyHtml} WHERE id = ${protocol.id}`
  return protocol.id
}

const titles = async (q: string, limit = 50) => (await searchProtocols(q, limit)).map((r) => r.title)

describe('searchProtocols on Postgres', () => {
  beforeEach(async () => {
    await getDb()`TRUNCATE org_units RESTART IDENTITY CASCADE`
  })

  it('matches the title anywhere in it, ignoring case', async () => {
    await seed('Haushaltsplan 2026', '2026-05-12')
    await seed('Wahlordnung', '2026-04-01')
    expect(await titles('SHALTSPL')).toEqual(['Haushaltsplan 2026'])
  })

  it('returns the unit, the status and the date as YYYY-MM-DD', async () => {
    await seed('Plenum', '2026-05-12')
    const [row] = await searchProtocols('plenum', 5)
    expect(row).toMatchObject({ title: 'Plenum', meetingDate: '2026-05-12', status: 'draft', committeeName: 'Gremium Plenum', visibility: 'all_members' })
  })

  it('wildcards and the escape character typed into the query match only themselves', async () => {
    await seed('Quote 100% erreicht', '2026-05-01')
    await seed('Quote 1000 erreicht', '2026-05-02')
    await seed('Raum a_b', '2026-05-03')
    await seed('Raum axb', '2026-05-04')
    await seed('Pfad a\\b', '2026-05-05')
    await seed('Pfad ab', '2026-05-06')
    expect(await titles('100%')).toEqual(['Quote 100% erreicht'])
    expect(await titles('a_b')).toEqual(['Raum a_b'])
    expect(await titles('a\\b')).toEqual(['Pfad a\\b'])
    expect(await titles('%')).toEqual(['Quote 100% erreicht'])
  })

  it('searches the body as text: markup is left out, blanks collapse', async () => {
    await seed('Sitzung', '2026-05-12', '<p class="wichtig">Der  Etat\n wurde <b>beschlossen</b></p>')
    expect(await titles('Etat wurde beschlossen')).toEqual(['Sitzung'])
    expect(await titles('wurde beschlossen')).toEqual(['Sitzung'])
    expect(await titles('wichtig')).toEqual([])
    expect(await titles('<p')).toEqual([])
    expect(await titles('class=')).toEqual([])
  })

  it('a protocol without a body is found by title and date and does not fail', async () => {
    await seed('Ohne Text', '2026-05-12', null)
    expect(await titles('ohne')).toEqual(['Ohne Text'])
    expect(await titles('12.05.2026')).toEqual(['Ohne Text'])
  })

  it('finds the meeting date typed as DD.MM.YYYY or YYYY-MM-DD', async () => {
    await seed('Maisitzung', '2026-05-12')
    await seed('Aprilsitzung', '2026-04-01')
    expect(await titles('12.05.2026')).toEqual(['Maisitzung'])
    expect(await titles('2026-05-12')).toEqual(['Maisitzung'])
    expect(await titles('01.04.2026')).toEqual(['Aprilsitzung'])
    expect(await titles('13.05.2026')).toEqual([])
  })

  it('lists the newest meeting first and returns at most `limit` rows', async () => {
    await seed('Plenum alt', '2026-01-10')
    await seed('Plenum neu', '2026-06-10')
    await seed('Plenum mitte', '2026-03-10')
    expect(await titles('plenum')).toEqual(['Plenum neu', 'Plenum mitte', 'Plenum alt'])
    expect(await titles('plenum', 2)).toEqual(['Plenum neu', 'Plenum mitte'])
  })
})
