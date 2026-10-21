// TASK-077 stack-proof, phase `up`: seeds the e2e PG with the kernel API's
// scratch world (control + gremion_platform + reader role + customers) through
// the SAME library path as the integration suite (scratch.ts, lane note C3),
// then rewrites each customer's secret ref to a file: ref the image reads from
// its read-only tenants mount, with the in-network database host.
//   T077_SEED_MODE=world   control, gremion_platform, reader, customers A and B
//   T077_SEED_MODE=late     customer C ("provisioned after the migrate job")
// State comes from T077_STATE (written by stack-proof.sh); results merge into it.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { buildWorld, connect, CONTROL_DB, createCustomer, enableModule, stack, type Customer, type ScratchWorld } from './scratch.ts'

const statePath = process.env.T077_STATE!
const st = JSON.parse(readFileSync(statePath, 'utf8')) as ReturnType<typeof stack> & Record<string, any>
const net = (u: string) => {
  const x = new URL(u)
  x.hostname = st.names.pg
  x.port = '5432'
  return x.toString()
}
const kc = (key: string) => ({ realm: `realm-${key}`, issuer: `http://127.0.0.1:${st.kcPort}/realms/realm-${key}`, kcInternal: `http://${st.names.kc}:8080/realms/realm-${key}` })

async function toFileRef(world: ScratchWorld, c: Customer) {
  const envName = c.ref.slice('env:'.length)
  writeFileSync(join(st.tenantsDir, `${c.slug}.dburl`), net(world.env[envName]!))
  await world.control`UPDATE tenant SET db_conn_ref = ${`file:/run/secrets/tenants/${c.slug}.dburl`} WHERE id = ${c.id}::uuid`
}

it(`seed ${process.env.T077_SEED_MODE}`, { timeout: 180_000 }, async () => {
  const mode = process.env.T077_SEED_MODE
  if (mode === 'world') {
    const world = await buildWorld()
    const A = await createCustomer(world, 'cust-a', 'a.example.org', kc('a'))
    const B = await createCustomer(world, 'cust-b', 'council-b.example', kc('b'))
    for (const c of [A, B]) await toFileRef(world, c)
    for (const m of ['board', 'calendar']) await enableModule(world, A.id, m)
    await enableModule(world, A.id, 'vault', 'disabled')
    await enableModule(world, B.id, 'content')
    st.customers = { a: { id: A.id, slug: A.slug, host: A.host, realm: 'realm-a' }, b: { id: B.id, slug: B.slug, host: B.host, realm: 'realm-b' } }
    st.readerControlUrl = net(world.readerControlUrl)
    st.readerPlatformUrl = net(world.readerPlatformUrl)
    st.catalogueSize = world.catalogueSize
    st.expectedEnabled = { a: ['board', 'calendar'], b: ['content'] }
    await world.close()
  } else if (mode === 'late') {
    const world: ScratchWorld = {
      admin: connect(st.db), control: connect(CONTROL_DB), platform: connect('gremion_platform'), env: {},
      readerControlUrl: '', readerPlatformUrl: '', catalogueSize: 0, async close() {},
    }
    const C = await createCustomer(world, 'cust-c', 'c.example.org', kc('c'))
    await toFileRef(world, C)
    st.customers.c = { id: C.id, slug: C.slug, host: C.host, realm: 'realm-c' }
    await Promise.all([world.admin.end({ timeout: 5 }), world.control.end({ timeout: 5 }), world.platform.end({ timeout: 5 })])
  } else {
    throw new Error('T077_SEED_MODE must be world|late')
  }
  writeFileSync(statePath, JSON.stringify(st, null, 2))
  console.log(`[t077] seeded (${mode})`)

})
