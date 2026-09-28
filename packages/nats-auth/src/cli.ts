// packages/nats-auth/src/cli.ts — `nats-auth init | ensure | render`
//
//   nats-auth init                                 SYS reload seed + accounts file (no network)
//   nats-auth ensure <tenant> --modules a,b,c     ensureTenantAccount (NATS_URL)
//   nats-auth ensure <tenant> --suspend           the empty set: only kernel + admin remain
//   nats-auth render                               print the accounts file the seeds render
//
// NATS_SECRETS_DIR (default /run/secrets/nats), NATS_ACCOUNTS_DIR (default
// /etc/nats/accounts). Run in the tenant-create container (Q11, Q12). Never
// prints a seed.
import { ensureTenantAccount, initAccounts, stateFromStore } from './ensure.ts'
import { renderServerConfig } from './render.ts'
import { SeedStore } from './store.ts'
import { secretsDirOf } from './connect.ts'

const USAGE = 'usage: nats-auth init | nats-auth ensure <tenant> (--modules a,b,c | --suspend) | nats-auth render'

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'init': {
      const r = await initAccounts()
      console.log(`[nats-auth] init: sys reload seed ${r.createdSysReload ? 'created' : 'present'}; ${r.accountsFile} ${r.wrote ? 'written' : 'unchanged'}`)
      if (r.wrote) console.log('[nats-auth] init: WARNING the accounts file changed -- a RUNNING broker keeps the old one until the next reload (nats-auth ensure) or restart')
      return 0
    }
    case 'ensure': {
      // Strict: the module set is declarative (an empty set SUSPENDS the
      // tenant's modules and deletes their seeds), so a mistyped flag must
      // never read as "no modules". --modules <a,b> or --suspend, nothing else.
      const [tenant, flag, value, ...extra] = rest
      let modules: string[] | undefined
      if (tenant && !tenant.startsWith('-') && extra.length === 0) {
        if (flag === '--modules' && value !== undefined && !value.startsWith('-')) {
          modules = value.split(',').map((x) => x.trim()).filter(Boolean)
          if (modules.length === 0) modules = undefined
        } else if (flag === '--suspend' && value === undefined) {
          modules = []
        }
      }
      if (!tenant || modules === undefined) {
        console.error(USAGE)
        return 2
      }
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
