// The kernel API's chain, ledger and module id (one place).
//
// Dependants grep `idt.schema_migration` under services/kernel-api/src (lane
// note C19): keep the literal here.

/** tenant-store module id of a customer's kernel database: t_<hex32>__kernel. */
export const KERNEL_MODULE = 'kernel'

/** The kernel-api chain's ledger, in the customer's kernel database (Q2, SCHEMA §0.6). */
export const KERNEL_API_LEDGER = 'idt.schema_migration'

/** The TASK-029 register chain id. */
export const KERNEL_API_CHAIN = 'kernel-api'

/**
 * The chain's migration dirs this image applies and gates on, relative to the
 * service root. Must equal ranges.json kernel-api manifestDirs (a test holds
 * them equal): TASK-080/081 add bodies/authz here AND there.
 */
export const KERNEL_API_MIGRATION_DIRS: readonly string[] = Object.freeze(['migrations/core', 'migrations/bodies'])
