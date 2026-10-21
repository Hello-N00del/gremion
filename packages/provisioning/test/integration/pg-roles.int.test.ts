// TASK-043d-1 TDD 2 and TDD 6 on the scratch PostgreSQL 18 (run.mjs):
//  - A1 (NIST SP 800-53 AC-6, ASVS 4.0.3 V1.4/V4.1.1): the panel role's
//    privilege matrix over EVERY relation of gremion_platform.plt and of the
//    control registry's public schema: SELECT on the read set only, no write
//    anywhere, EXECUTE on exactly plt.submit_provisioning_request; a direct
//    INSERT into, or UPDATE of, plt.provisioning_request is 42501;
//  - the executor role: no table privilege, exactly its functions, no
//    password, reachable over the state server's local socket (pg_hba
//    measured, not assumed) and NOT over TCP;
//  - SECURITY DEFINER hygiene of every 0005 function: search_path pinned,
//    nothing executable by PUBLIC, the status view without evidence_token.
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureExecutorRole, ensurePanelRequester, EXECUTOR_EXECUTES, PANEL_READS } from '../../src/index.ts'
import { code, open, scratchContainer, setupRoles, submit, submitArgs, type Roles } from './scratch.ts'

const FUNCTIONS_0005 = [
  'plt.provisioning_request_guard()',
  'plt.provisioning_member_of(text)',
  'plt.submit_provisioning_request(text,text,jsonb,uuid,uuid,text,timestamp with time zone,timestamp with time zone,text,text,text)',
  'plt.provisioning_assert_executor(text)',
  'plt.provisioning_requeue(uuid[],text)',
  'plt.claim_provisioning_request(text,integer)',
  'plt.requeue_own_requests(text)',
  'plt.renew_provisioning_lease(uuid,text,integer)',
  'plt.record_provisioning_event(uuid,text,text,text,text)',
  'plt.mark_provisioning_request_verified(uuid,text)',
  'plt.finish_provisioning_request(uuid,text,text,text)',
  'plt.executor_beat(text,text)',
]

let r: Roles

beforeAll(async () => {
  r = await setupRoles('roles')
})
afterAll(async () => {
  await r?.close()
})

type Row = { rel: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }

async function matrix(db: 'platform' | 'control'): Promise<Row[]> {
  const sql = db === 'platform' ? r.owner : open(r.control, 1)
  try {
    return await sql<Row[]>`
      SELECT format('%I.%I', n.nspname, c.relname) AS rel,
             has_table_privilege(${r.panelRole}, c.oid, 'SELECT') AS sel,
             has_table_privilege(${r.panelRole}, c.oid, 'INSERT') AS ins,
             has_table_privilege(${r.panelRole}, c.oid, 'UPDATE') AS upd,
             has_table_privilege(${r.panelRole}, c.oid, 'DELETE') AS del,
             has_table_privilege(${r.panelRole}, c.oid, 'TRUNCATE') AS trunc
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${db === 'platform' ? 'plt' : 'public'} AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
       ORDER BY 1`
  } finally {
    if (db === 'control') await sql.end()
  }
}

describe('A1: the panel role (ensurePanelRequester)', () => {
  it('prints the privilege matrix: SELECT on the read set only, INSERT/UPDATE/DELETE/TRUNCATE false everywhere', async () => {
    for (const db of ['platform', 'control'] as const) {
      const m = await matrix(db)
      console.log(`[A1] panel role ${r.panelRole} on ${db}:\n${m.map((x) => `  ${x.rel.padEnd(40)} select=${x.sel} insert=${x.ins} update=${x.upd} delete=${x.del} truncate=${x.trunc}`).join('\n')}`)
      const reads = new Set<string>(db === 'platform' ? PANEL_READS.platform : PANEL_READS.control)
      expect(m.filter((x) => x.sel).map((x) => x.rel).sort()).toEqual([...reads].sort())
      expect(m.filter((x) => x.ins || x.upd || x.del || x.trunc)).toEqual([])
      // the base table of the queue is NOT readable (the token lives there)
      if (db === 'platform') expect(m.find((x) => x.rel === 'plt.provisioning_request')).toMatchObject({ sel: false })
    }
  })

  it('EXECUTE on exactly one function: plt.submit_provisioning_request', async () => {
    const rows = await r.owner<{ sig: string }[]>`
      SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'plt' AND has_function_privilege(${r.panelRole}, p.oid, 'EXECUTE') ORDER BY 1`
    console.log(`[A1] panel role EXECUTE: ${rows.map((x) => x.sig).join(', ')}`)
    // the two trigger functions of 0001 keep PostgreSQL's PUBLIC default and cannot be called as functions
    expect(rows.map((x) => x.sig).filter((s) => !/^plt\.(touch_row|refuse_update)\(\)$/.test(s))).toEqual([
      'plt.submit_provisioning_request(text,text,jsonb,uuid,uuid,text,timestamp with time zone,timestamp with time zone,text,text,text)',
    ])
  })

  it('a direct INSERT into, UPDATE of, or SELECT from plt.provisioning_request as the panel role is 42501 (quoted)', async () => {
    const ins = await r.panel`INSERT INTO plt.provisioning_request DEFAULT VALUES`.then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    )
    console.log(`[A1] direct INSERT: ${ins?.code} ${ins?.message}`)
    expect(ins?.code).toBe('42501')
    expect(await code(r.panel`UPDATE plt.provisioning_request SET outcome = 'x'`)).toBe('42501')
    expect(await code(r.panel`SELECT evidence_token FROM plt.provisioning_request`)).toBe('42501')
    expect(await code(r.panel`SELECT count(*) FROM plt.provisioning_request_status`)).toBe('ok')
    expect(await code(r.panel`INSERT INTO plt.provisioning_request_event DEFAULT VALUES`)).toBe('42501')
    expect(await code(r.panel`UPDATE plt.executor_heartbeat SET seen_at = now()`)).toBe('42501')
    expect(await code(r.panel`SELECT plt.claim_provisioning_request('h1', 60)`)).toBe('42501')
    expect(await code(r.panelControl`INSERT INTO tenant (id, slug) VALUES (${crypto.randomUUID()}, 'x')`)).toBe('42501')
    expect(await code(r.panelControl`SELECT * FROM tenant_secret_ref`)).toBe('42501')
  })

  it('the role is LOGIN NOINHERIT only, a member of plt_panel_requester (no SET, no inherit) and not of plt_executor; a rerun is a no-op', async () => {
    const [a] = await r.admin<{ s: boolean; c: boolean; cr: boolean; b: boolean; inh: boolean; l: boolean }[]>`
      SELECT rolsuper AS s, rolcreatedb AS c, rolcreaterole AS cr, rolbypassrls AS b, rolinherit AS inh, rolcanlogin AS l FROM pg_roles WHERE rolname = ${r.panelRole}`
    expect(a).toEqual({ s: false, c: false, cr: false, b: false, inh: false, l: true })
    const m = await r.admin<{ role: string; inh: boolean; setopt: boolean }[]>`
      SELECT g.rolname AS role, m.inherit_option AS inh, m.set_option AS setopt FROM pg_auth_members m
        JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = ${r.panelRole}`
    expect(m).toEqual([{ role: 'plt_panel_requester', inh: false, setopt: false }])
    expect(await code(r.panel.unsafe('SET ROLE plt_panel_requester'))).toBe('42501')
    const again = await ensurePanelRequester({ kernelAdmin: r.admin, openAdminOn: (db) => open(db, 1), role: r.panelRole, password: r.panelPassword, controlDatabase: r.control })
    expect(again).toEqual({ created: false })
  })

  it('a stale extra grant is caught on the rerun (POSTCONDITION), never silently kept', async () => {
    await r.owner.unsafe(`GRANT INSERT ON plt.provisioning_request_event TO ${r.panelRole}`)
    try {
      await expect(
        ensurePanelRequester({ kernelAdmin: r.admin, openAdminOn: (db) => open(db, 1), role: r.panelRole, password: r.panelPassword, controlDatabase: r.control }),
      ).rejects.toMatchObject({ code: 'POSTCONDITION' })
    } finally {
      await r.owner.unsafe(`REVOKE INSERT ON plt.provisioning_request_event FROM ${r.panelRole}`)
    }
  })
})

describe('the executor role (ensureExecutorRole)', () => {
  it('no privilege on any relation of plt, EXECUTE on exactly its functions, LOGIN NOINHERIT, a member of plt_executor only', async () => {
    const rel = await r.owner<{ rel: string }[]>`
      SELECT c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'plt' AND c.relkind IN ('r', 'v') AND has_table_privilege(${r.executorRole}, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')`
    expect(rel).toEqual([])
    const fns = await r.owner<{ sig: string }[]>`
      SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'plt' AND p.prorettype <> 'trigger'::regtype AND has_function_privilege(${r.executorRole}, p.oid, 'EXECUTE') ORDER BY 1`
    const want = await r.owner<{ sig: string }[]>`SELECT to_regprocedure(s)::text AS sig FROM unnest(${[...EXECUTOR_EXECUTES]}::text[]) s ORDER BY 1`
    expect(fns.map((x) => x.sig)).toEqual(want.map((x) => x.sig))
    const m = await r.admin<{ role: string }[]>`
      SELECT g.rolname AS role FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = ${r.executorRole}`
    expect(m.map((x) => x.role)).toEqual(['plt_executor'])
  })

  it('gremion_executor: no password; the local socket (pg_hba measured) admits it, TCP does not', async () => {
    expect(await ensureExecutorRole({ kernelAdmin: r.admin, openAdminOn: (db) => open(db, 1) })).toMatchObject({ created: expect.any(Boolean) })
    const [pw] = await r.admin<{ has: boolean }[]>`SELECT rolpassword IS NOT NULL AS has FROM pg_authid WHERE rolname = 'gremion_executor'`
    expect(pw).toEqual({ has: false })
    const hba = await r.admin<{ type: string; database: string[]; user_name: string[]; auth_method: string }[]>`
      SELECT type, database, user_name, auth_method FROM pg_hba_file_rules WHERE error IS NULL ORDER BY rule_number`
    console.log(`[D3] pg_hba of the postgres:18 image: ${hba.map((h) => `${h.type} ${h.database.join(',')} ${h.user_name.join(',')} ${h.auth_method}`).join(' | ')}`)
    expect(hba.find((h) => h.type === 'local')?.auth_method).toBe('trust')
    const local = spawnSync('docker', ['exec', scratchContainer(), 'psql', '-X', '-U', 'gremion_executor', '-d', 'gremion_platform', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT plt.executor_beat('t043d-probe', 'test') IS NOT NULL"], {
      encoding: 'utf8',
    })
    expect(`${local.status} ${local.stdout.trim()}`).toBe('0 t')
    const tcp = open('gremion_platform', 1, 'gremion_executor', 'no-password-works')
    try {
      expect(await code(tcp`SELECT 1`)).toBe('28P01')
    } finally {
      await tcp.end({ timeout: 1 }).catch(() => {})
    }
  })

  it('a login role that is neither (the platform owner itself) cannot submit: 42501', async () => {
    expect(await code(submit(r.owner, submitArgs()))).toBe('42501')
  })
})

describe('TDD 6: SECURITY DEFINER hygiene of 0005', () => {
  it('every 0009 function pins search_path = pg_catalog, pg_temp and none is executable by PUBLIC', async () => {
    const rows = await r.owner<{ sig: string; cfg: string[] | null; pub: boolean; definer: boolean }[]>`
      SELECT p.oid::regprocedure::text AS sig, p.proconfig AS cfg, p.prosecdef AS definer,
             has_function_privilege('public', p.oid, 'EXECUTE') AS pub
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'plt'`
    const mine = rows.filter((x) => FUNCTIONS_0005.includes(x.sig))
    expect(mine.map((x) => x.sig).sort()).toEqual([...FUNCTIONS_0005].sort())
    for (const f of mine) {
      expect(f.cfg, f.sig).toContain('search_path=pg_catalog, pg_temp')
      expect(f.pub, f.sig).toBe(false)
    }
    // the externally granted ones are the definers
    expect(mine.filter((x) => x.definer).map((x) => x.sig.replace(/\(.*/, '')).sort()).toEqual(
      ['claim_provisioning_request', 'executor_beat', 'finish_provisioning_request', 'mark_provisioning_request_verified', 'record_provisioning_event', 'renew_provisioning_lease', 'requeue_own_requests', 'submit_provisioning_request'].map((n) => `plt.${n}`),
    )
  })

  it('the status view carries every request column but evidence_token', async () => {
    const cols = await r.owner<{ c: string }[]>`
      SELECT attname AS c FROM pg_attribute WHERE attrelid = 'plt.provisioning_request_status'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`
    const base = await r.owner<{ c: string }[]>`
      SELECT attname AS c FROM pg_attribute WHERE attrelid = 'plt.provisioning_request'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`
    expect(cols.map((x) => x.c)).not.toContain('evidence_token')
    expect(cols.map((x) => x.c)).toEqual(base.map((x) => x.c).filter((c) => c !== 'evidence_token'))
  })
})
