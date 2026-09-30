// apps/control-panel/src/lib/server/executor.ts — "Neuer Mandant" (FLOW-OPS-001
// A-D, Q6). The panel mutates nothing itself: with PANEL_EXECUTOR=gremion-tenant
// it starts `gremion-tenant create` (argv only, never a shell), whose phase A
// registers the customer's control row and pending ledger first; the status
// page then shows the ledger filling. With no executor the button is disabled
// and says why (newCustomerDisabledReason).
import { spawn } from 'node:child_process'

export interface NewCustomerInput {
  slug: string
  host: string
  itAdmin: string
  councilAdmin: string
  enable: string[]
  configFile: string
}

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const MODULE = /^[a-z][a-z0-9_]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Validates the form and returns the field errors (empty: valid). board is refused by name (R29-I1). */
export function validateNewCustomer(input: NewCustomerInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!SLUG.test(input.slug) || input.slug.length < 3 || input.slug.length > 30 || input.slug === 'platform') {
    errors.slug = 'Kurzname: 3-30 Zeichen, a-z, 0-9 und einzelne Bindestriche, beginnend mit einem Buchstaben; nicht "platform".'
  }
  if (!HOST.test(input.host)) errors.host = 'Hostname in Kleinbuchstaben, z. B. rat.musterstadt.de.'
  if (!EMAIL.test(input.itAdmin.toLowerCase())) errors.itAdmin = 'E-Mail-Adresse der IT-Administration.'
  if (!EMAIL.test(input.councilAdmin.toLowerCase())) errors.councilAdmin = 'E-Mail-Adresse der Gremienverwaltung.'
  if (input.enable.some((m) => !MODULE.test(m))) errors.enable = 'Module als Kennungen, z. B. calendar.'
  else if (input.enable.includes('board')) errors.enable = 'board ist noch nicht mandantengetrennt und kann nicht aktiviert werden (R29-I1).'
  return errors
}

/** The argv of `gremion-tenant create` -- no shell, every value one element. */
export function createArgv(input: NewCustomerInput, operatorId: string): string[] {
  if (!UUID.test(operatorId)) throw new Error('the operator id is not a uuid')
  const argv = [
    'create',
    input.slug,
    '--host',
    input.host,
    '--config',
    input.configFile,
    '--it-admin',
    input.itAdmin.toLowerCase(),
    '--council-admin',
    input.councilAdmin.toLowerCase(),
    '--operator',
    operatorId,
  ]
  if (input.enable.length) argv.push('--enable', [...new Set(input.enable)].sort().join(','))
  return argv
}

export type Spawner = (cmd: string, argv: string[]) => void

const defaultSpawner: Spawner = (cmd, argv) => {
  const child = spawn(cmd, argv, { stdio: 'ignore', detached: true, shell: false })
  child.unref()
}

export function startCreate(input: NewCustomerInput, operatorId: string, spawner: Spawner = defaultSpawner): string[] {
  const argv = createArgv(input, operatorId)
  spawner('gremion-tenant', argv)
  return argv
}
