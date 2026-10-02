export interface CastInput {
  heliosBase: string
  electionUuid: string
  encryptedVote: string
  auditHash: string
}

export interface CastResult {
  castUrl: string
  auditUrl: string
}

export async function castBallot(input: CastInput): Promise<CastResult> {
  const { heliosBase, electionUuid, encryptedVote, auditHash } = input
  const url = `${heliosBase}/helios/elections/${electionUuid}/cast`
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_vote: encryptedVote, audit_hash: auditHash }),
  })
  if (!res.ok) throw new Error(`Helios cast → ${res.status}`)
  const json = (await res.json()) as { cast_url?: string; audit_url?: string }
  return {
    castUrl: json.cast_url ?? '',
    auditUrl: json.audit_url ?? '',
  }
}
