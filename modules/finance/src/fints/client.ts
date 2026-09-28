// services/finance/src/fints/client.ts
// #383 Lane E3 — provider seam for FinTS. Ported from the native oracle
// gremion-ui/.../services/money/{fints-client.ts,lib-fints-client.ts}.
//
// G-019b ZKA POSTURE (the load-bearing fact for this lane): the production client is
// gated on FINTS_PRODUCT_ID, which is UNSET until ZKA registration completes
// (fints.org Produktregistrierung, operator-side, ~10 business days). Until then the
// production path throws FintsTransportError with the SAME message as the native
// oracle — so an unconfigured syncFints answers IDENTICALLY leaf-side and native-side
// (both record the failed sync + return { imported:0, skipped:0, errors:[msg] }).
//
// The full lib-fints statement-fetch flow (TAN handoff, BPD/UPD persistence, per-
// account discovery) is NOT wired into the leaf — that is the operator-activation
// follow-up once FinTS goes live. The seam lets fints/sync.ts unit-test the
// persist/dedup path with FakeFintsClient without pulling network or credentials.
import type { BankStatementRow } from '../bank/types.js'
import { FintsAuthError, FintsTransportError } from './errors.js'

export interface FintsCredentials {
  readonly fintsUrl: string
  readonly bankCode: string
  readonly username: string
  readonly password: string
  readonly iban: string
}

export interface FintsClient {
  getStatements(
    input: FintsCredentials & { fromDate: string; toDate: string },
  ): Promise<{ statements: readonly BankStatementRow[]; balanceCents: number | null }>
}

/**
 * Production FinTS client. Consults FINTS_PRODUCT_ID first and throws
 * FintsTransportError when unset — matching the native LibFintsClient message so the
 * unconfigured-sync result is byte-identical across both modes. When the env IS set
 * (post-ZKA), the leaf still refuses: the full lib-fints transport is an operator-
 * activation follow-up (live FinTS sync remains ZKA-gated in both modes).
 */
export class ProdFintsClient implements FintsClient {
  async getStatements(): Promise<{ statements: readonly BankStatementRow[]; balanceCents: number | null }> {
    const productId = process.env.FINTS_PRODUCT_ID
    if (!productId) {
      throw new FintsTransportError(
        'FINTS_PRODUCT_ID env var is not set — register at ' +
          'fints.org/de/hersteller/produktregistrierung before enabling FinTS sync',
      )
    }
    // Post-ZKA the real lib-fints transport lands here (operator-activation follow-up).
    throw new FintsTransportError(
      'FinTS live transport is not wired into the finance leaf yet — ' +
        'operator activation follow-up (lib-fints TAN/discovery flow)',
    )
  }
}

/**
 * In-memory FinTS double for unit tests. Stage statements / balance / errors with the
 * dedicated stage*() methods before calling getStatements(). Mirrors the native
 * FakeFintsClient.
 */
export class FakeFintsClient implements FintsClient {
  private staged: BankStatementRow[] = []
  private balance: number | null = null
  private err: 'auth' | 'transport' | null = null

  stageStatements(rows: BankStatementRow[]): void {
    this.staged = rows
  }

  stageBalance(cents: number): void {
    this.balance = cents
  }

  stageAuthError(): void {
    this.err = 'auth'
  }

  stageTransportError(): void {
    this.err = 'transport'
  }

  async getStatements(): Promise<{ statements: readonly BankStatementRow[]; balanceCents: number | null }> {
    if (this.err === 'auth') throw new FintsAuthError('staged auth error')
    if (this.err === 'transport') throw new FintsTransportError('staged transport error')
    return { statements: this.staged, balanceCents: this.balance }
  }
}
