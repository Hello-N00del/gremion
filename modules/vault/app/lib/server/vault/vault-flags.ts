// src/lib/server/vault/vault-flags.ts
import { env } from '$env/dynamic/private'

/** #405 (design v11): step-up gate on ciphertext delivery — the reveal endpoint
 *  requires a FRESH LoA 2 before the server hands out a secret ("erst nach
 *  frischer 2FA liefert der Server Chiffretexte aus"). Default ON — unlike the
 *  finance flag this ships enforcing, because the vault has no pre-step-up
 *  install base; set VAULT_REVEAL_REQUIRE_STEPUP=false to disable (e.g. local
 *  dev without the KC browser-stepup flow). */
export function vaultStepUpEnforced(): boolean {
  return (env.VAULT_REVEAL_REQUIRE_STEPUP ?? 'true').toLowerCase() !== 'false'
}

/** Step-up validity window in seconds (default 300). Reads the SAME module-
 *  neutral STEPUP_FRESHNESS_SECONDS knob as the finance #164 enforcement (one
 *  elevation window platform-wide) — re-implemented here rather than imported
 *  so the vault module never depends on finance internals. */
export function stepUpFreshnessSeconds(): number {
  const n = Number(env.STEPUP_FRESHNESS_SECONDS ?? '300')
  return Number.isFinite(n) && n > 0 ? n : 300
}
