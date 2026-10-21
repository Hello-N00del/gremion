// packages/events/src/plumbing.ts (@gremion/events)
//
// plumbingSql(ctx): the standard infrastructure tables of one service database
// (SCHEMA §0.6: binding, current_customer_id, touch_row, outbox, inbox,
// applied_aggregate_version, job) as the lint-clean DDL of sql/plumbing.sql,
// rendered for one context code. A service copies the text BYTE-FOR-BYTE as the
// first block of its first hash-locked migration; checkPlumbingMigration proves
// that it did (TASK-079 Q5, TASK-080, TASK-084).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TEMPLATE_FILE = fileURLToPath(new URL('../sql/plumbing.sql', import.meta.url))

/** A context code is 2-4 lower-case letters (the outbox source CHECK, the binding list). */
const CTX_RE = /^[a-z]{2,4}$/

export function assertContext(ctx: string): void {
  if (typeof ctx !== 'string' || !CTX_RE.test(ctx)) {
    throw new TypeError(`[events] context code ${JSON.stringify(ctx)} is not 2-4 lower-case letters`)
  }
}

let template: string | undefined

/**
 * The template with its two variables substituted EXACTLY: `{{ctx}}` (schema
 * qualifier, profile name) and `{{CTX}}` (DB ids). Nothing else is replaced, so
 * the context-code list of database_binding stays literal for every context.
 */
export function plumbingSql(ctx: string): string {
  assertContext(ctx)
  template ??= readFileSync(TEMPLATE_FILE, 'utf8').replace(/\r\n/g, '\n')
  return template.replaceAll('{{ctx}}', ctx).replaceAll('{{CTX}}', ctx.toUpperCase())
}

export class PlumbingDriftError extends Error {
  override name = 'PlumbingDriftError'
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message)
  }
}

/**
 * The rendered plumbing must be the BYTE-0 prefix of the migration text. Throws
 * PlumbingDriftError naming the first differing byte offset (and line), else
 * returns. A file that adds its own statements after the block is fine.
 */
export function checkPlumbingText(text: string, ctx: string): void {
  const want = plumbingSql(ctx)
  if (text.startsWith(want)) return
  let i = 0
  const n = Math.min(text.length, want.length)
  while (i < n && text.charCodeAt(i) === want.charCodeAt(i)) i++
  const line = want.slice(0, i).split('\n').length
  throw new PlumbingDriftError(
    i === text.length
      ? `[events] the migration ends at byte ${i} (line ${line}), inside the ${ctx} plumbing block`
      : `[events] the migration departs from plumbingSql('${ctx}') at byte ${i} (line ${line}): the block must be the file's byte-0 prefix, unchanged`,
    i,
  )
}

/** checkPlumbingText over a migration file on disk. */
export function checkPlumbingMigration(file: string, ctx: string): void {
  checkPlumbingText(readFileSync(file, 'utf8'), ctx)
}
