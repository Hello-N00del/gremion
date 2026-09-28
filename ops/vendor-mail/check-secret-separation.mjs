#!/usr/bin/env node
// TASK-015 (TRD-251): the vendor's own mail shares NO secret with any
// per-council connector.
//
//   node ops/vendor-mail/check-secret-separation.mjs            # verify: (a) + (b)
//   node ops/vendor-mail/check-secret-separation.mjs --host      # a host's stores
//        [--env-dir D] [--secrets-dir D] [--ui-env FILE]
//
// THE TWO SETS
//   vendor     every generator group mail.env.tmpl references, and the keys
//              STALWART_*, VENDOR_SMTP_PASSWORD, ALERT_SMTP_PASSWORD,
//              PLATFORM_SMTP_PASSWORD (the vendor's sending identities and
//              the Stalwart admin surface).
//   connector  what a council's own mail connector can read: app.env.tmpl
//              (the app tier every council request runs in), and wherever
//              they appear, EMAIL_HOST_PASSWORD and TENANT_SECRETS_DIR (the
//              per-tenant store, /run/secrets/tenants/<name>).
//
// ARMS
//   (a) templates  a vendor GROUP (not merely a key name: a renamed key with
//                  the same sentinel group is the same secret) or a vendor KEY
//                  in the connector set.
//   (b) compose    the five projects of TASK-040 (state, app-blue, app-green,
//                  ops, mail) rendered by scripts/check-pooled-stack.mjs's
//                  renderProject -- no third renderer -- from THIS task's
//                  fixtures (__fixtures__/env/, one distinct value per group):
//                  any state/app/ops service environment value that resolves
//                  to (or embeds) a vendor value. Vacuity guards: > 0 app
//                  services rendered, and the vendor values pairwise distinct;
//                  a render that fails is unparseable, never "no finding".
//   --host         value HASHES (sha256) over etc/env/*.env, etc/secrets/mail/*
//                  (vendor) and etc/secrets/tenants/** plus the running
//                  gremion-ui containers' environment (connector). No value is
//                  ever printed. An unreadable store is unparseable.
//
// BLIND SPOT, named: a `docker compose run -e X=...` injection (as
// test/host/integration/pooled-stack-proof.sh does for tenant-create) is in
// no template and no render; only --host sees it, and only while that
// container lives.
//
// EXIT: 0 no shared secret - 1 a shared secret (or a stale allowance) -
//       2 unparseable input / usage.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { envMap, readTemplates, REPO_ROOT, sha256, templateSentinels } from './lib/env.mjs'
import { loadAllowances } from './lib/allowances.mjs'
import { FIXTURE_REL } from './lib/fixture-env.mjs'

export const VENDOR_TEMPLATE = 'mail.env.tmpl'
export const CONNECTOR_TEMPLATE = 'app.env.tmpl'
export const VENDOR_KEY_RE = /^(STALWART_[A-Z0-9_]+|VENDOR_SMTP_PASSWORD|ALERT_SMTP_PASSWORD|PLATFORM_SMTP_PASSWORD)$/
export const CONNECTOR_KEY_RE = /^(EMAIL_HOST_PASSWORD|TENANT_SECRETS_DIR)$/
/** Keys of mail.env whose values are vendor SECRETS (the value arms compare these). */
export const VENDOR_SECRET_KEY_RE = /^(STALWART_ADMIN_PASSWORD|STALWART_API_KEY|VENDOR_SMTP_PASSWORD|ALERT_SMTP_PASSWORD|PLATFORM_SMTP_PASSWORD|ROLES_IMAP_PASSWORD)$/

const allowed = (allowances, { file, key, group, vendorKey }) =>
  allowances.separation.find(
    (a) => a.connectorFile === file && a.connectorKey === key && (group === undefined || a.vendorGroup === group) && (vendorKey === undefined || a.vendorKey === vendorKey),
  )

// ── (a) templates ──────────────────────────────────────────────────────────

/** @returns {{violations: string[], used: Set<string>}} */
export function staticViolations(templates, allowances) {
  const vendorText = templates[VENDOR_TEMPLATE]
  if (!vendorText) throw new Error(`${VENDOR_TEMPLATE} is missing`)
  const vendorRefs = templateSentinels(vendorText, VENDOR_TEMPLATE)
  const vendorGroups = new Map() // group -> first vendor key
  for (const r of vendorRefs) if (!vendorGroups.has(r.group)) vendorGroups.set(r.group, `${r.key} (${VENDOR_TEMPLATE}:${r.line})`)
  const vendorKeys = new Set(
    vendorText
      .split(/\r?\n/)
      .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1])
      .filter((k) => k && VENDOR_KEY_RE.test(k)),
  )
  const violations = []
  const used = new Set()
  // The connector set: all of app.env.tmpl, and the connector keys anywhere.
  const connector = []
  for (const [file, text] of Object.entries(templates)) {
    const lines = text.split(/\r?\n/)
    lines.forEach((l, i) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l)
      if (!m) return
      if (file === CONNECTOR_TEMPLATE || CONNECTOR_KEY_RE.test(m[1])) connector.push({ file, key: m[1], value: m[2], line: i + 1 })
    })
  }
  for (const c of connector) {
    const at = `${c.file}:${c.line}`
    for (const m of c.value.matchAll(/CHANGE_ME_GEN_(?:hex32|alnum32)_([a-z0-9_]+)/g)) {
      const group = m[1]
      if (!vendorGroups.has(group)) continue
      const a = allowed(allowances, { file: c.file, key: c.key, group })
      if (a) {
        used.add(a.id)
        continue
      }
      violations.push(`${at} ${c.key} shares the vendor generator group '${group}' with ${vendorGroups.get(group)}`)
    }
    if (vendorKeys.has(c.key)) {
      const a = allowed(allowances, { file: c.file, key: c.key, vendorKey: c.key })
      if (a) used.add(a.id)
      else violations.push(`${at} declares the vendor key ${c.key} in the connector set`)
    }
  }
  // A pair that no longer exists is a stale allowance: it would silently
  // permit whatever next reuses the name.
  for (const a of allowances.separation) {
    const pairLive = connector.some((c) => c.file === a.connectorFile && c.key === a.connectorKey && c.value.includes(`_${a.vendorGroup}`)) && vendorGroups.has(a.vendorGroup)
    if (!pairLive || !used.has(a.id)) violations.push(`stale allowance '${a.id}': the pair ${a.connectorFile} ${a.connectorKey} <-> vendor group '${a.vendorGroup}' no longer exists -- remove the allowance`)
  }
  return { violations, used }
}

// ── (b) rendered compose ───────────────────────────────────────────────────

export const FIXTURE_PROJECT_IDS = ['state', 'app-blue', 'app-green', 'ops', 'mail']

/** TASK-040's five projects, re-pointed at this task's fixture env files. */
export async function fixtureProjects() {
  const { PROJECTS } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'check-pooled-stack.mjs')).href)
  const ids = PROJECTS.map((p) => p.id)
  if (JSON.stringify(ids) !== JSON.stringify(FIXTURE_PROJECT_IDS)) {
    throw new Error(`scripts/check-pooled-stack.mjs PROJECTS changed (${ids.join(',')}); the separation fixtures cover ${FIXTURE_PROJECT_IDS.join(',')}`)
  }
  return PROJECTS.map((p) => ({ ...p, envFile: `${FIXTURE_REL}/${path.basename(p.envFile)}` }))
}

export async function defaultRender() {
  const { renderProject } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'check-pooled-stack.mjs')).href)
  return renderProject
}

function envEntries(svc) {
  const env = svc?.environment ?? {}
  if (Array.isArray(env)) return env.map((e) => [String(e).split('=')[0], String(e).split('=').slice(1).join('=')])
  return Object.entries(env).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])
}

/**
 * @param {Array<{id: string, render?: object, error?: string}>} renders
 * @param {Record<string,string>} vendorValues vendor secret key -> fixture value
 * @returns {{unparseable: string|null, violations: string[], appServices: number}}
 */
export function composeViolations(renders, vendorValues, allowances) {
  const failed = renders.filter((r) => r.error)
  if (failed.length) return { unparseable: failed.map((r) => `${r.id}: render failed: ${r.error}`).join('; '), violations: [], appServices: 0 }
  const entries = Object.entries(vendorValues)
  if (entries.length === 0) return { unparseable: 'no vendor secret value to compare against', violations: [], appServices: 0 }
  const violations = []
  const byValue = new Map()
  for (const [k, v] of entries) {
    if (!v) violations.push(`vendor key ${k} has an empty fixture value -- the comparison would be vacuous`)
    if (byValue.has(v)) violations.push(`vendor keys ${byValue.get(v)} and ${k} share one fixture value -- the comparison cannot tell them apart (vacuous)`)
    else byValue.set(v, k)
  }
  let appServices = 0
  for (const { id, render } of renders) {
    if (id === 'mail') continue
    const services = render?.services ?? {}
    if (id.startsWith('app-')) appServices += Object.keys(services).length
    for (const [name, svc] of Object.entries(services)) {
      for (const [k, v] of envEntries(svc)) {
        for (const [vk, vv] of entries) {
          if (!vv || !v.includes(vv)) continue
          if (id.startsWith('app-') && allowed(allowances, { file: CONNECTOR_TEMPLATE, key: vk, vendorKey: vk })) continue
          violations.push(`${id}/${name}: environment ${k} resolves to the vendor secret ${vk}`)
        }
      }
    }
  }
  if (appServices === 0) violations.push('zero app services rendered -- the connector arm read nothing')
  return { unparseable: null, violations, appServices }
}

export async function runCompose({ render, projects, fixtureDir = path.join(REPO_ROOT, FIXTURE_REL), allowances = loadAllowances() } = {}) {
  render ??= await defaultRender()
  projects ??= await fixtureProjects()
  const mail = envMap(readFileSync(path.join(fixtureDir, 'mail.env'), 'utf8'), 'mail.env')
  const vendorValues = Object.fromEntries(Object.entries(mail).filter(([k]) => VENDOR_SECRET_KEY_RE.test(k)))
  const renders = projects.map((p) => {
    try {
      return { id: p.id, render: render(p) }
    } catch (e) {
      return { id: p.id, error: String(e.message).split('\n')[0] }
    }
  })
  return composeViolations(renders, vendorValues, allowances)
}

// ── --host: value hashes over the live stores ──────────────────────────────

/** Every regular file under dir (recursive), as [relPath, content]. Throws on
 * an unreadable directory or file: an unreadable store is not an empty one. */
export function readStore(dir, { reader = readFileSync, lister = readdirSync, stat = statSync } = {}) {
  const out = []
  const walk = (d, rel) => {
    for (const name of lister(d)) {
      const p = path.join(d, name)
      const r = rel ? `${rel}/${name}` : name
      if (stat(p).isDirectory()) walk(p, r)
      else out.push([r, String(reader(p, 'utf8')).trim()])
    }
  }
  walk(dir, '')
  return out
}

/**
 * @param {{envDir: string, secretsDir: string, uiEnvFile: string|null, allowances: object, io?: object}} o
 */
export function hostViolations({ envDir, secretsDir, uiEnvFile, allowances, io = {} }) {
  const reader = io.reader ?? readFileSync
  let mail
  try {
    mail = envMap(String(reader(path.join(envDir, 'mail.env'), 'utf8')), 'mail.env')
  } catch (e) {
    return { unparseable: `cannot read mail.env: ${e.code ?? e.message}`, violations: [] }
  }
  const vendor = new Map() // hash -> label
  for (const [k, v] of Object.entries(mail)) if (VENDOR_SECRET_KEY_RE.test(k) && v) vendor.set(sha256(v), `mail.env ${k}`)
  if (vendor.size === 0) return { unparseable: 'mail.env carries no vendor secret value', violations: [] }
  try {
    for (const [rel, content] of readStore(path.join(secretsDir, 'mail'), io)) if (content) vendor.set(sha256(content), `secrets/mail/${rel}`)
  } catch (e) {
    return { unparseable: `cannot read the vendor store secrets/mail: ${e.code ?? e.message}`, violations: [] }
  }
  const connector = []
  for (const colour of ['blue', 'green']) {
    let app
    try {
      app = envMap(String(reader(path.join(envDir, `app-${colour}.env`), 'utf8')), `app-${colour}.env`)
    } catch (e) {
      return { unparseable: `cannot read app-${colour}.env: ${e.code ?? e.message}`, violations: [] }
    }
    for (const [k, v] of Object.entries(app)) if (v) connector.push({ label: `app-${colour}.env ${k}`, key: k, hash: sha256(v), file: CONNECTOR_TEMPLATE })
  }
  try {
    for (const [rel, content] of readStore(path.join(secretsDir, 'tenants'), io)) if (content) connector.push({ label: `secrets/tenants/${rel}`, hash: sha256(content) })
  } catch (e) {
    return { unparseable: `cannot read the connector store secrets/tenants: ${e.code ?? e.message}`, violations: [] }
  }
  if (uiEnvFile) {
    let tsv
    try {
      tsv = String(reader(uiEnvFile, 'utf8'))
    } catch (e) {
      return { unparseable: `cannot read the gremion-ui environment hashes: ${e.code ?? e.message}`, violations: [] }
    }
    for (const line of tsv.split('\n').filter(Boolean)) {
      const [colour, key, hash] = line.split('\t')
      if (!/^[0-9a-f]{64}$/.test(hash ?? '')) return { unparseable: `gremion-ui environment hash line is malformed`, violations: [] }
      connector.push({ label: `gremion-ui (${colour}) env ${key}`, key, hash, file: CONNECTOR_TEMPLATE })
    }
  }
  const violations = []
  for (const c of connector) {
    const v = vendor.get(c.hash)
    if (!v) continue
    const vendorKey = v.startsWith('mail.env ') ? v.slice('mail.env '.length) : null
    if (c.key && vendorKey && c.key === vendorKey && allowed(allowances, { file: c.file, key: c.key, vendorKey })) continue
    violations.push(`${c.label} holds the same value as ${v}`)
  }
  return { unparseable: null, violations, vendorCount: vendor.size, connectorCount: connector.length }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { host: false, envDir: '/run/gremion/env-all', secretsDir: '/run/gremion/secrets', uiEnv: '/run/gremion/collect/ui-env.tsv' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--host') o.host = true
    else if (a === '--env-dir') o.envDir = argv[++i]
    else if (a === '--secrets-dir') o.secretsDir = argv[++i]
    else if (a === '--ui-env') o.uiEnv = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  return o
}

export async function main(argv = process.argv.slice(2), log = console, { compose = runCompose } = {}) {
  let o
  try {
    o = parseArgs(argv)
  } catch (e) {
    log.error(`usage: check-secret-separation.mjs [--host [--env-dir D] [--secrets-dir D] [--ui-env F]]: ${e.message}`)
    return 2
  }
  let allowances
  try {
    allowances = loadAllowances()
  } catch (e) {
    log.error(`UNPARSEABLE allowances.json: ${e.message}`)
    return 2
  }
  if (o.host) {
    const r = hostViolations({ envDir: o.envDir, secretsDir: o.secretsDir, uiEnvFile: o.uiEnv, allowances })
    if (r.unparseable) {
      log.error(`UNPARSEABLE ${r.unparseable}`)
      return 2
    }
    for (const v of r.violations) log.error(`FAIL ${v}`)
    log.log(`SECRET-SEPARATION: mode=host vendor-values=${r.vendorCount} connector-values=${r.connectorCount} shared=${r.violations.length}`)
    return r.violations.length ? 1 : 0
  }
  const a = staticViolations(readTemplates(), allowances)
  const b = await compose({ allowances })
  for (const v of a.violations) log.error(`FAIL (a) ${v}`)
  if (b.unparseable) {
    log.error(`UNPARSEABLE (b) ${b.unparseable}`)
    return 2
  }
  for (const v of b.violations) log.error(`FAIL (b) ${v}`)
  const n = a.violations.length + b.violations.length
  log.log(`SECRET-SEPARATION: mode=verify static=${a.violations.length} compose=${b.violations.length} app-services=${b.appServices}`)
  return n ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
