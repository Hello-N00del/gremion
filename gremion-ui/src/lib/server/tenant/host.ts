// src/lib/server/tenant/host.ts
// Tenancy D1 (design spec §1.3) — the ONE host normaliser.
//
// TASK-077 G6 (TRD-074, TRD-076): the implementation moved, unchanged, to
// packages/tenancy-core/src/host.ts so the kernel API and gremion-ui share ONE
// normaliser (read path, write path and the kernel API's host check cannot
// disagree). This file keeps every import site in gremion-ui working: the
// export names are byte-identical. kernel-portable.guard.test.ts scans the
// package source.
export { hostFromIssuer, normaliseHost } from '@gremion/tenancy-core/host'
