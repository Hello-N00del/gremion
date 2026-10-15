// src/lib/vault/vault-view.ts
//
// #405 (design v11) — CLIENT-SAFE pure helpers for the native /vault surface
// (prototype web/vault.jsx VaultScreen). No server imports; everything here is
// deterministic (clock/rng injected) so the unit tests drive it directly.

/** Client-side auto-lock: the vault re-locks 5 minutes after unlocking. */
export const VAULT_AUTO_LOCK_MS = 5 * 60_000

/** A revealed secret auto-hides after 20 s (prototype VaultRow). */
export const SECRET_AUTO_HIDE_MS = 20_000

/**
 * Lock-state mapping (HONEST version of the prototype lockState machine): the
 * ONE real gate is the server's step-up enforcement on ciphertext delivery
 * (GET /api/vault/[id]/secret → 401 STEP_UP_REQUIRED). The page therefore
 * renders LOCKED exactly when that gate would fire: enforcement ON and the
 * session's LoA 2 not fresh. A fresh-loa2 session (or enforcement switched off
 * via VAULT_REVEAL_REQUIRE_STEPUP=false) renders unlocked directly — no fake
 * passkey/passphrase theater (the WebAuthn-PRF lane is the E2E-Zielbild).
 */
export function initialVaultLock(stepUpEnforced: boolean, stepUpOk: boolean): boolean {
  return stepUpEnforced && !stepUpOk
}

/** One org-unit compartment ("Fach") as the page renders it. */
export interface VaultUnitView {
  id: string
  name: string
  kind: string
  hue: number
  abbr: string
}

/**
 * Compartment visibility (prototype VaultScreen unitsWithItems): every in-scope
 * unit gets a card — EXCEPT an empty council compartment (the top-level Rat
 * itself rarely holds shared credentials; an empty card there is noise). A
 * council WITH items still renders.
 */
export function visibleUnits<T extends { id: string; kind: string }>(
  units: readonly T[],
  itemCountByUnit: ReadonlyMap<string, number>,
): T[] {
  return units.filter((u) => (itemCountByUnit.get(u.id) ?? 0) > 0 || u.kind !== 'council')
}

// Manual dd.mm.yyyy / hh:mm formatting — deterministic across ICU builds
// (toLocale* output varies by Node ICU data; the systemstatus page tolerates
// that for relative times, a golden-testable meta line must not).
const p2 = (n: number) => String(n).padStart(2, '0')

/** 'angelegt 12.03.2026' meta-line date (prototype VaultRow item.created). */
export function formatVaultDate(d: Date): string {
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`
}

/** '14.07.2026 · 11:03' Zugriffsprotokoll row timestamp (prototype log ts). */
export function formatVaultLogTs(d: Date): string {
  return `${formatVaultDate(d)} · ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

// ── Passphrase generator (VaultCreate "Generieren") ──────────────────────────
// Word-based like the prototype fixtures ('korrekt-pferd-batterie-27!'):
// four random words + two digits + one symbol. 40 words → ~21 bits/word;
// 4 words + 2 digits + symbol ≈ 92 bits — comfortably beyond online-guessing
// range for a server-side-encrypted shared credential.
const WORDS = [
  'anker', 'birke', 'diesel', 'echo', 'fossil', 'gitarre', 'hafen', 'insel',
  'jaguar', 'kamera', 'lampe', 'marmor', 'nebel', 'orbit', 'pinsel', 'quitte',
  'rakete', 'signal', 'teppich', 'ufer', 'vulkan', 'wal', 'yacht', 'zebra',
  'ampel', 'brise', 'dattel', 'fenster', 'granit', 'humus', 'kiesel', 'lotse',
  'melodie', 'nadel', 'opal', 'pferd', 'raute', 'segel', 'tundra', 'wiese',
] as const
const SYMBOLS = ['!', '?', '#', '$', '%'] as const

/**
 * Generate a word-based passphrase. `random` mirrors Math.random's contract
 * ([0,1)); the page passes a crypto-backed source, the tests a deterministic one.
 */
export function generatePassphrase(random: () => number = cryptoRandom): string {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length) % arr.length]!
  const words = Array.from({ length: 4 }, () => pick(WORDS))
  const digits = `${Math.floor(random() * 10)}${Math.floor(random() * 10)}`
  return `${words.join('-')}-${digits}${pick(SYMBOLS)}`
}

/** Uniform [0,1) from the Web Crypto CSPRNG (available in browser + Node 20). */
function cryptoRandom(): number {
  const buf = new Uint32Array(1)
  globalThis.crypto.getRandomValues(buf)
  return buf[0]! / 2 ** 32
}
