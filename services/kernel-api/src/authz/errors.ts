// services/kernel-api/src/authz/errors.ts — typed refusals of the grant service.
// `status` is the HTTP status the route maps it to; `code` is the problem+json
// detail key. A refusal always means ZERO rows were written (one transaction).
export type GrantErrorCode =
  | 'bad_request'
  | 'insufficient_user_authentication'
  | 'granter_role_mismatch'
  | 'self_grant'
  | 'forbidden'
  | 'platform_level'
  | 'unknown_subject'
  | 'unknown_body'
  | 'unknown_key'
  | 'module_not_enabled'
  | 'role_scope'
  | 'not_open'
  | 'constraint'

const STATUS: Record<GrantErrorCode, number> = {
  bad_request: 400,
  insufficient_user_authentication: 401,
  granter_role_mismatch: 403,
  self_grant: 403,
  forbidden: 403,
  platform_level: 403,
  unknown_subject: 422,
  unknown_body: 422,
  unknown_key: 422,
  module_not_enabled: 409,
  role_scope: 422,
  not_open: 409,
  constraint: 422,
}

export class GrantError extends Error {
  override name = 'GrantError'
  readonly status: number
  constructor(
    readonly code: GrantErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.status = STATUS[code]
  }
}
