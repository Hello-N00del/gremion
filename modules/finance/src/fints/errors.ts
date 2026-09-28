// services/finance/src/fints/errors.ts
// #383 Lane E3 — typed FinTS errors. Ported from the native oracle
// gremion-ui/.../services/money/errors.ts (the two FinTS members). Message strings are
// byte-identical to the native so the recorded last_sync_error / errors[] entries
// match at the API surface.

export class FintsAuthError extends Error {
  constructor(msg: string) {
    super(`FinTS auth error: ${msg}`)
    this.name = 'FintsAuthError'
  }
}

export class FintsTransportError extends Error {
  constructor(msg: string) {
    super(`FinTS transport error: ${msg}`)
    this.name = 'FintsTransportError'
  }
}
