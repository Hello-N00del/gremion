// src/lib/server/tenant/reserved-hosts.ts
// Spec A §C / §H.2 — the platform-reserved names under PLATFORM_DOMAIN.
//
// TASK-077 G6: the implementation moved, unchanged, to
// packages/tenancy-core/src/reserved-hosts.ts (shared with the kernel API).
// Export names are byte-identical; reserved-hosts.test.ts still asserts the
// list equals RESERVED_HOSTS in infra/host/templates/env/state.env.tmpl.
export { isReservedPlatformHost, RESERVED_PLATFORM_LABELS, reservedPlatformHosts } from '@gremion/tenancy-core/reserved-hosts'
