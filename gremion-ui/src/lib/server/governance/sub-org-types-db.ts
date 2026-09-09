// src/lib/server/governance/sub-org-types-db.ts
// Repository for the sub_org_type catalog (migration 018). Mirrors the
// finance reference repo (finance-unit-db.ts): raw `postgres` template
// literals via getRunner(tx), tx? first-param overloads, BIGINT-to-number
// boundary cast, and a namespaced `subOrgTypesDb` export at the bottom.
//
// Ownership note: governance owns this table and uses the NEUTRAL
// lib/server/db/tx getRunner (Pillar-1 P0.1), defaulting to the governance
// pool (getDb). It no longer reverse-imports the finance tx helper; both
// pools share DATABASE_URL today, so the runtime selection is unchanged.
import { getRunner as genericGetRunner, unpackTxArgs, type PgTransaction } from '$lib/server/db/tx'
import { getDb } from '../db'

/** Governance-pool-defaulting runner (was reverse-imported from finance, P0.1).
 *  getDb is passed as a factory to preserve the lazy `tx ?? pool()` short-circuit. */
const getRunner = (tx: PgTransaction | undefined) => genericGetRunner(tx, getDb)

export interface SubOrgType {
  readonly id: number
  readonly name: string
  readonly description: string | null
}

/** Raw DB row before the boundary cast — postgres returns BIGINT as string. */
interface SubOrgTypeRow {
  id: string
  name: string
  description: string | null
}

/** Normalise BIGINT-as-string id to number — the repository boundary cast. */
export function parseSubOrgType(row: SubOrgTypeRow): SubOrgType {
  return { id: Number(row.id), name: row.name, description: row.description }
}

export async function listSubOrgTypes(tx?: PgTransaction): Promise<readonly SubOrgType[]> {
  const sql = getRunner(tx)
  const rows = await sql<SubOrgTypeRow[]>`
    SELECT id, name, description FROM sub_org_type ORDER BY id`
  return rows.map(parseSubOrgType)
}

export async function getSubOrgType(id: number): Promise<SubOrgType | null>
export async function getSubOrgType(tx: PgTransaction, id: number): Promise<SubOrgType | null>
export async function getSubOrgType(
  txOrId: PgTransaction | number, maybeId?: number
): Promise<SubOrgType | null> {
  const tx = typeof txOrId === 'function' ? (txOrId as PgTransaction) : undefined
  const id = typeof txOrId === 'function' ? (maybeId as number) : (txOrId as number)
  const sql = getRunner(tx)
  const rows = await sql<SubOrgTypeRow[]>`
    SELECT id, name, description FROM sub_org_type WHERE id = ${id}`
  return rows[0] ? parseSubOrgType(rows[0]) : null
}

export interface CreateSubOrgTypeInput {
  readonly name: string
  readonly description?: string | null
}

export async function createSubOrgType(data: CreateSubOrgTypeInput): Promise<SubOrgType>
export async function createSubOrgType(tx: PgTransaction, data: CreateSubOrgTypeInput): Promise<SubOrgType>
export async function createSubOrgType(
  txOrData: PgTransaction | CreateSubOrgTypeInput, maybeData?: CreateSubOrgTypeInput
): Promise<SubOrgType> {
  const { tx, data } = unpackTxArgs<CreateSubOrgTypeInput>(txOrData, maybeData)
  const sql = getRunner(tx)
  const description = data.description ?? null
  const rows = await sql<SubOrgTypeRow[]>`
    INSERT INTO sub_org_type (name, description)
    VALUES (${data.name}, ${description})
    RETURNING id, name, description`
  return parseSubOrgType(rows[0]!)
}

export async function deleteSubOrgType(id: number): Promise<void>
export async function deleteSubOrgType(tx: PgTransaction, id: number): Promise<void>
export async function deleteSubOrgType(
  txOrId: PgTransaction | number, maybeId?: number
): Promise<void> {
  const tx = typeof txOrId === 'function' ? (txOrId as PgTransaction) : undefined
  const id = typeof txOrId === 'function' ? (maybeId as number) : (txOrId as number)
  const sql = getRunner(tx)
  await sql`DELETE FROM sub_org_type WHERE id = ${id}`
}

// ── namespaced surface (consumer-facing) ────────────────────────────────
export const subOrgTypesDb = {
  list: listSubOrgTypes,
  getById: getSubOrgType,
  insert: createSubOrgType,
  delete: deleteSubOrgType
} as const
