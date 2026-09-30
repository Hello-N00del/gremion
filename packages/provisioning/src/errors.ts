// packages/provisioning/src/errors.ts — the one error type the package throws.
// The CLI maps `code` to its exit status and prints the message; nothing here
// carries a secret.

export type ProvisioningErrorCode =
  | 'INVALID_INPUT'
  | 'MODULE_UNKNOWN'
  | 'MODULE_DENIED'
  /** In the catalogue, but `init` loaded no plt.module_version for it (Q20). */
  | 'MODULE_NOT_LOADED'
  | 'STEP_OUT_OF_ORDER'
  | 'STEP_FAILED'
  | 'CUSTOMER_STATE'
  | 'POSTCONDITION'
  | 'PRECONDITION'
  | 'NOT_FOUND'

export class ProvisioningError extends Error {
  override name = 'ProvisioningError'
  constructor(
    readonly code: ProvisioningErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A lowercase RFC 9562 uuid (Keycloak user ids are v4, control ids v7). */
export function assertUuid(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ProvisioningError('INVALID_INPUT', `${what} is not a lowercase RFC 9562 uuid: ${JSON.stringify(value)}`)
  }
}
