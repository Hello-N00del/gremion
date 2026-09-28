// services/finance/src/csv/iban.ts
// #383 Lane E3 — IBAN normaliser + mod-97 validator. Ported verbatim from the native
// oracle gremion-ui/.../services/money/iban.ts (ISO 13616). After normalisation the
// rearranged string (letters A=10..Z=35) modulo 97 must equal 1.

/** Strip whitespace and uppercase. Always call before validating. */
export function normaliseIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase()
}

/** mod-97 check-digit validation. Assumes input is already normalised. */
export function validateIban(iban: string): boolean {
  // Country code (2 letters) + 2 check digits + 1..30 alnum (BBAN).
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(iban)) return false
  // Rearrange: move the first 4 chars to the end.
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  // Replace each letter with its alphabetic ordinal + 9 (A=10..Z=35).
  const numeric = rearranged.replace(/[A-Z]/g, (c) => (c.charCodeAt(0) - 55).toString())
  // Modulo 97 on the (potentially very long) integer string, one digit at a time.
  let mod = 0
  for (const ch of numeric) {
    mod = (mod * 10 + Number(ch)) % 97
  }
  return mod === 1
}
