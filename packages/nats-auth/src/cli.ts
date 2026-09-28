// packages/nats-auth/src/cli.ts — `nats-auth init | ensure | render`
//
//   nats-auth init                                 SYS reload seed + accounts file (no network)
//   nats-auth ensure <tenant> [--modules a,b,c]   ensureTenantAccount (NATS_URL)
//   nats-auth render                               print the accounts file the seeds render
//
// NATS_SECRETS_DIR (default /run/secrets/nats), NATS_ACCOUNTS_DIR (default
// /etc/nats/accounts). Run in the tenant-create container (Q11, Q12). Never
// prints a seed.
import { ensureTenantAccount, initAccounts, stateFromStore } from './ensure.ts'
import { renderServerConfig } from './render.ts'
import { SeedStore } from './store.ts'
import { secretsDirOf } from './connect.ts'

const USAGE = 'usage: nats-auth init | nats-auth ensure <tenant> [--modules a,b,c] | nats-auth render'

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'init': {
      const r = await initAccounts()
      console.log(`[nats-auth] init: sys reload seed ${r.createdSysReload ? 'created' : 'present'}; ${r.accountsFile} ${r.wrote ? 'written' : 'unchanged'}`)
      return 0
    }
    case 'ensure': {
      const tenant = rest[0]
      if (!tenant || tenant.startsWith('-')) {
        console.error(USAGE)
        return 2
      }
      const i = rest.indexOf('--modules')
      const modules = i === -1 ? [] : (rest[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const r = await ensureTenantAccount({ tenant, modules })
      console.log(JSON.stringify(r))
      return 0
    }
    case 'render':
      process.stdout.write(renderServerConfig(stateFromStore(new SeedStore(secretsDirOf()))))
      return 0
    default:
      console.error(USAGE)
      return 2
  }
}
