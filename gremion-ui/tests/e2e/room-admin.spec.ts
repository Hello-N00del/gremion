/**
 * Room administration — signed-in spec (TASK-205b, post-condition 3; TASK-009's R1-R3 ported).
 *
 * The messaging module's room administration, against the RUNNING system (never a mock, never a bare 2xx):
 *   R1  an IT admin creates a room for a probe org unit through "Raum erstellen" on /messages;
 *   R2  renames it from the room header's "Einstellungen" panel;
 *   R3  archives it (the room then lives read-only under the sidebar's "Archiv" section) and, on a SECOND
 *       probe, hard-deletes a room (ITAdmin-only, R23-4); /messages/manage ("Verwaltung -> Räume", the 'Räume'
 *       rail entry with the matrix glyph) shows 'Archiviert' for the first unit and 'Noch kein Raum' for the
 *       second, a durable server-side post-condition;
 *   and a council admin who is NOT an IT admin is refused the hard delete (403), whatever the room.
 *
 * Ported from StuRaOS test/f1-defect/e2e/admin-mutation-surfaces.spec.ts R1-R3 WITHOUT its blanket
 * `test.skip`: a missing variable FAILS every test (never skips), so an unconfigured run cannot pass vacuously.
 * Reads E2E_BASE_URL, E2E_ITADMIN_USER / E2E_ITADMIN_PASS (an IT admin) and E2E_ADMIN_USER / E2E_ADMIN_PASS
 * (a council admin without the IT admin role) from the environment; no host name, address or credential is
 * written here. Probe objects are named `r205-probe-<n>` and removed again through the CouncilAdmin DELETE
 * route the members admin surface uses, whatever the test outcome. Executed by TASK-209 on the test environment.
 */
import { test, expect, type Page } from '@playwright/test'

const ENV_KEYS = ['E2E_BASE_URL', 'E2E_ITADMIN_USER', 'E2E_ITADMIN_PASS', 'E2E_ADMIN_USER', 'E2E_ADMIN_PASS'] as const
const missingEnv = ENV_KEYS.filter((k) => !process.env[k])

test.use({ baseURL: process.env.E2E_BASE_URL })

function requireEnv() {
  expect(missingEnv, `missing environment: ${missingEnv.join(', ')}`).toEqual([])
}

type Who = 'itadmin' | 'council'
const CREDS: Record<Who, { user: string; pass: string }> = {
  itadmin: { user: process.env.E2E_ITADMIN_USER ?? '', pass: process.env.E2E_ITADMIN_PASS ?? '' },
  council: { user: process.env.E2E_ADMIN_USER ?? '', pass: process.env.E2E_ADMIN_PASS ?? '' },
}

async function signIn(page: Page, who: Who) {
  requireEnv()
  await page.goto('/')
  // The app bounces to the Keycloak login theme (docker/keycloak/themes/gremion). One attempt, no retry: a
  // second bad login risks the brute-force lockout.
  await page.locator('#username').waitFor()
  await page.locator('#username').fill(CREDS[who].user)
  await page.locator('#password').fill(CREDS[who].pass)
  await page.locator('button[name="login"], #kc-login').first().click()
  await page.waitForURL((url) => url.origin === new URL(process.env.E2E_BASE_URL!).origin && !url.pathname.startsWith('/auth'))
}

/** Whole-text match (whitespace-tolerant) for hasText, so "#1" never matches "#10". */
function exactText(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*${escaped}\\s*$`)
}

test.describe('messaging room administration', () => {
  // The flow creates two probe org units per run; they are removed again, whatever the outcome. 404 = already
  // gone; anything else fails the run, because leftover fixture data is a defect of the run, not noise.
  const probeUnitIds: string[] = []
  test.afterEach(async ({ page }) => {
    const ids = probeUnitIds.splice(0)
    const failures: string[] = []
    for (const id of ids) {
      const res = await page.request.delete(`/api/governance/committees/${id}`)
      if (res.status() !== 200 && res.status() !== 404) failures.push(`${id}: ${res.status()} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    }
    expect(failures, `probe org unit cleanup failed for ${failures.length} of ${ids.length} unit(s)`).toEqual([])
  })

  test("R1-R3: an IT admin creates, renames and archives a probe unit's room and hard-deletes a second probe's room; /messages/manage agrees", async ({ page }) => {
    await signIn(page, 'itadmin')
    const suffix = Date.now()
    const probeA = `r205-probe-${suffix}-a`
    const probeB = `r205-probe-${suffix}-b`

    // The probe org unit starts WITHOUT a Matrix room (the 'leer' state), so it is eligible for "Raum erstellen"'s
    // picker. A committee needs a parent: read a real council from the governance API.
    const UNIT_URL = /\/members\/committees\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
    type OrgUnitRow = { id: string; name: string; kind: string; parent_id: string | null }
    async function listUnits(): Promise<OrgUnitRow[]> {
      const res = await page.request.get('/api/governance/committees')
      expect(res.status(), `GET /api/governance/committees -> ${res.status()}`).toBe(200)
      const body = (await res.json()) as { success: boolean; data: OrgUnitRow[] }
      expect(body.success).toBe(true)
      return body.data
    }
    const council = (await listUnits()).find((u) => u.kind === 'council')
    if (!council) throw new Error('createProbeUnit: no council org unit exists to parent the probe committee under')

    async function createProbeUnit(name: string): Promise<void> {
      await page.goto('/members/committees/new', { waitUntil: 'domcontentloaded' })
      await page.fill('#name', name)
      await page.locator('select[name="kind"]').selectOption('committee')
      await page.locator('select[name="parentId"]').selectOption(council!.id)
      const matrixCheckbox = page.locator('input[name="wantsMatrixRoom"]')
      if (await matrixCheckbox.isChecked()) await matrixCheckbox.uncheck()
      const ncCheckbox = page.locator('input[name="wantsNextcloudFolder"]')
      if (await ncCheckbox.isChecked()) await ncCheckbox.uncheck()
      const navigated = page.waitForURL(UNIT_URL, { timeout: 20000 }).then(() => true, () => false)
      await page.locator('form button[type="submit"]').click()
      if (!(await navigated)) {
        const shown = page.locator('p.text-rust')
        const err = (await shown.count()) > 0 ? (await shown.first().innerText()).trim() : ''
        throw new Error(`createProbeUnit(${name}) failed: still on ${page.url()} - ` + (err ? `page error: "${err}"` : 'no visible validation error'))
      }
      const unitId = UNIT_URL.exec(page.url())![1]!.toLowerCase()
      probeUnitIds.push(unitId)
      const created = (await listUnits()).find((u) => u.id.toLowerCase() === unitId)
      expect(created, `unit ${unitId} (${name}) missing from GET /api/governance/committees`).toBeDefined()
      expect(created!.name).toBe(name)
    }

    await createProbeUnit(probeA)
    await createProbeUnit(probeB)

    // Rows are scoped to the sidebar and matched on the exact room name; `${probeA}-renamed` contains probeA.
    const roomList = page.locator('aside.room-list')
    const activeRow = (name: string) => roomList.locator('button.room-item:not(.archived)').filter({ has: page.getByText(name, { exact: true }) })
    const archivedRow = (name: string) => roomList.locator('.archiv-section button.room-item.archived').filter({ has: page.getByText(name, { exact: true }) })
    const anyRow = (name: string) => roomList.locator('button.room-item').filter({ has: page.getByText(name, { exact: true }) })
    // The Einstellungen panel resolves the room's org unit asynchronously and its buttons are enabled before
    // that returns: wait for the lookup like a user does, and require it to succeed.
    async function openSettings(): Promise<void> {
      const lookup = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/messages\/rooms\/[^/]+\/unit$/.test(new URL(r.url()).pathname), { timeout: 15000 })
      await page.getByRole('button', { name: /einstellungen/i }).click()
      const res = await lookup
      expect(res.status(), `room -> unit lookup ${new URL(res.url()).pathname}`).toBe(200)
    }

    // R1: create probeA's room through "Raum erstellen" on /messages.
    await page.goto('/messages', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /raum erstellen/i }).click()
    await page.locator('select').first().selectOption({ label: probeA })
    await page.getByRole('button', { name: /^erstellen$/i }).click()
    await expect(activeRow(probeA)).toHaveCount(1, { timeout: 10000 })

    // R2: rename it via the room header's "Einstellungen" panel.
    await activeRow(probeA).click()
    await openSettings()
    const renamed = `${probeA}-renamed`
    await page.getByLabel(/raumname/i).fill(renamed)
    await page.getByRole('button', { name: /speichern/i }).click()
    await expect(activeRow(renamed)).toHaveCount(1, { timeout: 10000 })
    await expect(anyRow(probeA)).toHaveCount(0)

    // R3 (archive, R23-4's normal path): the room now lives read-only under the sidebar's "Archiv" section.
    await activeRow(renamed).click()
    await openSettings()
    await page.getByRole('button', { name: /^archivieren$/i }).click()
    await page.getByRole('button', { name: /bestätigen/i }).click()
    await expect(archivedRow(renamed)).toHaveCount(1, { timeout: 10000 })
    await expect(activeRow(renamed)).toHaveCount(0)

    // R3 (hard delete, ITAdmin-only, R23-4): a SEPARATE probe/room, so it neither satisfies nor undoes the archive.
    await page.goto('/messages', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /raum erstellen/i }).click()
    await page.locator('select').first().selectOption({ label: probeB })
    await page.getByRole('button', { name: /^erstellen$/i }).click()
    await expect(activeRow(probeB)).toHaveCount(1, { timeout: 10000 })
    await activeRow(probeB).click()
    await openSettings()
    await page.getByRole('button', { name: /^löschen$/i }).click()
    await page.getByRole('button', { name: /bestätigen/i }).click()
    await expect(anyRow(probeB)).toHaveCount(0, { timeout: 10000 })

    // Durable server-side post-condition: the 'Räume' overview (/messages/manage) reads the ledger plus the
    // bot-authored archive marker in Matrix: probeA's unit reads "Archiviert", probeB's unit "Noch kein Raum".
    await page.goto('/messages/manage', { waitUntil: 'domcontentloaded' })
    const manageRow = (unitName: string) => page.locator('.rooms-section .room-row').filter({ has: page.locator('.unit-name', { hasText: exactText(unitName) }) })
    await expect(manageRow(probeA).locator('.state-pill')).toHaveText('Archiviert', { timeout: 15000 })
    await expect(manageRow(probeB).locator('.state-pill')).toHaveText('Noch kein Raum')
  })

  test("a council admin sees the 'Räume' rail entry and /messages/manage, but the hard delete is refused (ITAdmin-only)", async ({ page }) => {
    await signIn(page, 'council')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    // the messaging manifest's rail entry, CouncilAdmin-gated, drawn with the matrix glyph
    const raeume = page.locator('.nav-col a.sb-item[href="/messages/manage"]')
    await expect(raeume).toHaveCount(1)
    const manage = await page.goto('/messages/manage')
    expect(manage!.status()).toBe(200)
    // the destructive route answers 403 before it looks at the room: a non-IT admin never reaches deleteRoom
    const res = await page.request.delete('/api/messages/rooms/!r205-nonexistent:invalid?orgUnitId=00000000-0000-7000-8000-000000000000')
    expect(res.status()).toBe(403)
  })

  test('without a session the room administration API answers 401, never data', async ({ playwright }) => {
    requireEnv()
    const anon = await playwright.request.newContext({ baseURL: process.env.E2E_BASE_URL })
    try {
      const res = await anon.delete('/api/messages/rooms/!r205-nonexistent:invalid?orgUnitId=00000000-0000-7000-8000-000000000000')
      expect([401, 403]).toContain(res.status())
    } finally {
      await anon.dispose()
    }
  })
})
