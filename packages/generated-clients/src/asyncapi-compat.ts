// packages/generated-clients/src/asyncapi-compat.ts
//
// T4: AsyncAPI 3.0 payload compat — same version-bump rule as OpenAPI (T3),
// but oasdiff does not classify AsyncAPI at all, so this is a small,
// PURPOSE-BUILT structural comparator scoped to exactly what the brief §5
// (decision 6) asks for: `components.messages.*.payload`. A removed or
// newly-required property, a narrowed/changed type, or a removed enum value
// needs a MAJOR bump; a new optional property needs at least MINOR.
//
// `@asyncapi/diff` was considered first (brief's stated preference) but is
// not in this lockfile: adding it here would need a TASK-017 build-script
// allowlist entry for a dependency whose AsyncAPI-3.0 support is, per the
// brief itself, unproven ("unclassified = breaking" was the fallback
// reading). A ~30-line comparator over one well-defined shape is easier to
// trust AND to test than an opaque tool's verdict on a spec version it may
// not fully understand — this is the "or a custom comparison" branch of
// decision 6, taken because it fits comfortably in the size budget.
import { stripCompatNoise, classifyVersionBump, type CompatResult } from './oasdiff-gate.js'

interface PayloadSchema {
  type?: string
  required?: string[]
  properties?: Record<string, PayloadSchema>
  enum?: unknown[]
}

interface AsyncApiMessage { payload?: PayloadSchema }

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function messagesOf(doc: unknown): Record<string, AsyncApiMessage> {
  const components = isPlainRecord(doc) ? doc.components : undefined
  const messages = isPlainRecord(components) ? components.messages : undefined
  return isPlainRecord(messages) ? (messages as Record<string, AsyncApiMessage>) : {}
}

export interface PayloadCompatResult { breaking: boolean; reasons: string[] }

/** Structural comparison of every `components.messages.*.payload` between two
 *  AsyncAPI documents. Scoped deliberately narrow (brief §5 decision 6): it
 *  does not attempt full JSON Schema compatibility (e.g. numeric ranges,
 *  `oneOf`/`anyOf`), only the four rules the brief names. */
export function compareAsyncApiPayloads(oldDoc: unknown, newDoc: unknown): PayloadCompatResult {
  const reasons: string[] = []
  let breaking = false
  const oldMsgs = messagesOf(oldDoc)
  const newMsgs = messagesOf(newDoc)

  for (const name of Object.keys(oldMsgs)) {
    if (!(name in newMsgs)) {
      breaking = true
      reasons.push(`message "${name}" removed`)
      continue
    }
    const oldPayload = oldMsgs[name]?.payload
    const newPayload = newMsgs[name]?.payload
    const oldProps = oldPayload?.properties ?? {}
    const newProps = newPayload?.properties ?? {}
    const oldRequired = new Set(oldPayload?.required ?? [])
    const newRequired = new Set(newPayload?.required ?? [])

    for (const prop of Object.keys(oldProps)) {
      if (!(prop in newProps)) {
        breaking = true
        reasons.push(`${name}.payload.${prop}: property removed`)
        continue
      }
      const oldType = oldProps[prop]?.type
      const newType = newProps[prop]?.type
      if (oldType !== undefined && newType !== undefined && oldType !== newType) {
        breaking = true
        reasons.push(`${name}.payload.${prop}: type changed/narrowed "${oldType}" -> "${newType}"`)
      }
      const oldEnum = oldProps[prop]?.enum
      const newEnum = newProps[prop]?.enum
      if (Array.isArray(oldEnum) && Array.isArray(newEnum)) {
        const newSet = new Set(newEnum)
        const removedValues = oldEnum.filter((v) => !newSet.has(v))
        if (removedValues.length > 0) {
          breaking = true
          reasons.push(`${name}.payload.${prop}: enum value(s) removed: ${removedValues.map(String).join(', ')}`)
        }
      }
      if (!oldRequired.has(prop) && newRequired.has(prop)) {
        breaking = true
        reasons.push(`${name}.payload.${prop}: property became required`)
      }
    }

    for (const prop of Object.keys(newProps)) {
      if (prop in oldProps) continue
      if (newRequired.has(prop)) {
        breaking = true
        reasons.push(`${name}.payload.${prop}: new REQUIRED property added`)
      } else {
        reasons.push(`${name}.payload.${prop}: new optional property added`)
      }
    }
  }

  for (const name of Object.keys(newMsgs)) {
    if (!(name in oldMsgs)) reasons.push(`message "${name}" added`)
  }

  return { breaking, reasons }
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(stripCompatNoise(a)) === JSON.stringify(stripCompatNoise(b))
}

/** The same rule as `checkOpenApiCompat` (oasdiff-gate.ts), applied via
 *  `compareAsyncApiPayloads` instead of oasdiff — T4 mirrors T3 exactly. */
export function checkAsyncApiCompat(oldRaw: string, newRaw: string): CompatResult {
  const oldDoc = JSON.parse(oldRaw) as { info?: { version?: string } }
  const newDoc = JSON.parse(newRaw) as { info?: { version?: string } }
  const oldVersion = oldDoc.info?.version ?? ''
  const newVersion = newDoc.info?.version ?? ''

  if (structurallyEqual(oldDoc, newDoc)) {
    return { ok: true, breaking: false, structuralChange: false, bump: classifyVersionBump(oldVersion, newVersion), reason: 'no structural change (description-only or identical)' }
  }

  const { breaking, reasons } = compareAsyncApiPayloads(oldDoc, newDoc)
  const bump = classifyVersionBump(oldVersion, newVersion)

  if (breaking) {
    const ok = bump === 'major'
    return {
      ok,
      breaking: true,
      structuralChange: true,
      bump,
      reason: ok
        ? `breaking AsyncAPI payload change, major bump ${oldVersion} -> ${newVersion}: OK`
        : `breaking AsyncAPI payload change requires a MAJOR bump; got ${oldVersion} -> ${newVersion} (${bump}).\n${reasons.join('\n')}`,
    }
  }
  const ok = bump === 'major' || bump === 'minor'
  return {
    ok,
    breaking: false,
    structuralChange: true,
    bump,
    reason: ok
      ? `non-breaking AsyncAPI payload addition, ${bump} bump ${oldVersion} -> ${newVersion}: OK`
      : `non-breaking AsyncAPI payload addition (an addition) requires at least a MINOR bump; got ${oldVersion} -> ${newVersion} (${bump}).\n${reasons.join('\n')}`,
  }
}
