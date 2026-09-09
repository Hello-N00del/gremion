// gremion-ui/src/lib/auth/step-up.ts
// Pure Level-of-Assurance helpers. Provider-agnostic + clock-injected so they
// are deterministically testable (matches the project's clock-injection pattern).

export const LOA = { PASSWORD: 1, STEP_UP: 2 } as const;

// Mirrors the realm acr.loa.map. Accepts both the named acr values and the
// numeric strings Keycloak may return; unknown/absent → 0.
export const ACR_TO_LOA: Readonly<Record<string, number>> = { loa1: 1, loa2: 2, '1': 1, '2': 2 };

export function acrToLoa(acr: string | null | undefined): number {
  if (!acr) return 0;
  return ACR_TO_LOA[acr] ?? 0;
}

export interface StepUpSubject { loa: number; authTime: number /* epoch seconds */ }
export type StepUpDecision = { ok: true } | { ok: false; requiredLoa: number; reason: 'loa' | 'stale' };

export function evaluateStepUp(
  subject: StepUpSubject,
  requiredLoa: number,
  opts: { nowMs: number; freshnessSeconds: number },
): StepUpDecision {
  if (requiredLoa <= LOA.PASSWORD) return { ok: true };
  if (subject.loa < requiredLoa) return { ok: false, requiredLoa, reason: 'loa' };
  const ageSeconds = opts.nowMs / 1000 - subject.authTime;
  if (ageSeconds > opts.freshnessSeconds) return { ok: false, requiredLoa, reason: 'stale' };
  return { ok: true };
}
