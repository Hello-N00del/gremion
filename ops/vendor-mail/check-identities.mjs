#!/usr/bin/env node
// TASK-015: the vendor's alerting identity is ONE address, alerts@<domain>.
//
//   node ops/vendor-mail/check-identities.mjs [--mail-env F] [--ops-env F]
//
// Alertmanager authenticates as ALERT_SMTP_USER and writes ALERT_EMAIL_FROM
// into every alert (infra/host/ops/alertmanager.yml.tmpl). Stalwart's
// must-match-sender (config.toml.tmpl [session.auth]) refuses a From that is
// not the authenticated principal's with 5.7.1, so the two MUST be the same
// address, and it must be the principal provision-roles.sh creates:
// alerts@<PLATFORM_DOMAIN>. Both keys are operator sentinels in ops.env.tmpl
// (the template renders no ${PLATFORM_DOMAIN}: gremion-init-secrets substitutes
// only STACK/COLOUR/subnets and refuses a surviving placeholder), so this is
// the post-condition that the operator filled them in consistently.
//
// Also, across FILES (gremion-validate-env compares aliases within one file
// only): ALERT_SMTP_PASSWORD in ops.env equals mail.env's (the alert_smtp
// group), PLATFORM_DOMAIN agrees, ALERT_SMTP_HOST is mail.<PLATFORM_DOMAIN>.
// No value is printed except the non-secret addresses.
//
// EXIT: 0 consistent - 1 an identity mismatch - 2 unreadable input / usage.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envMap, sha256 } from './lib/env.mjs'

export function identityViolations(mail, ops) {
  const out = []
  const domain = mail.PLATFORM_DOMAIN
  if (!domain || domain.startsWith('CHANGE_ME_')) return { unparseable: 'mail.env PLATFORM_DOMAIN is unset', violations: [] }
  const want = `alerts@${domain}`
  if (ops.PLATFORM_DOMAIN !== domain) out.push(`ops.env PLATFORM_DOMAIN (${ops.PLATFORM_DOMAIN ?? 'absent'}) differs from mail.env's (${domain})`)
  for (const k of ['ALERT_SMTP_USER', 'ALERT_EMAIL_FROM']) {
    const v = ops[k]
    if (v === undefined || v === '') out.push(`ops.env ${k} is unset; it must be ${want}`)
    else if (v.startsWith('CHANGE_ME_')) out.push(`ops.env ${k} still holds its operator sentinel; it must be ${want}`)
    else if (v !== want) out.push(`ops.env ${k} is ${v}; it must be ${want} (the alerts@ principal; must-match-sender refuses anything else with 5.7.1)`)
  }
  if (ops.ALERT_SMTP_HOST !== undefined && !ops.ALERT_SMTP_HOST.startsWith('CHANGE_ME_') && ops.ALERT_SMTP_HOST !== `mail.${domain}`) {
    out.push(`ops.env ALERT_SMTP_HOST is ${ops.ALERT_SMTP_HOST}; alerts are submitted to mail.${domain}`)
  }
  const a = mail.ALERT_SMTP_PASSWORD
  const b = ops.ALERT_SMTP_PASSWORD
  if (!a || !b) out.push('ALERT_SMTP_PASSWORD is missing from mail.env or ops.env')
  else if (sha256(a) !== sha256(b)) out.push('ALERT_SMTP_PASSWORD differs between mail.env and ops.env (alert_smtp drift): Alertmanager would authenticate with a password alerts@ does not hold')
  return { unparseable: null, violations: out }
}

export function main(argv = process.argv.slice(2), log = console) {
  let mailFile = '/run/gremion/env/mail.env'
  let opsFile = '/run/gremion/env/ops.env'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mail-env') mailFile = argv[++i]
    else if (argv[i] === '--ops-env') opsFile = argv[++i]
    else {
      log.error(`usage: check-identities.mjs [--mail-env F] [--ops-env F]: unknown argument ${argv[i]}`)
      return 2
    }
  }
  let mail, ops
  try {
    mail = envMap(readFileSync(mailFile, 'utf8'), 'mail.env')
    ops = envMap(readFileSync(opsFile, 'utf8'), 'ops.env')
  } catch (e) {
    log.error(`UNPARSEABLE ${e.code ?? ''} ${e.message}`)
    return 2
  }
  const r = identityViolations(mail, ops)
  if (r.unparseable) {
    log.error(`UNPARSEABLE ${r.unparseable}`)
    return 2
  }
  for (const v of r.violations) log.error(`FAIL ${v}`)
  log.log(`IDENTITIES: alerts=alerts@${mail.PLATFORM_DOMAIN} mismatches=${r.violations.length}`)
  return r.violations.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
