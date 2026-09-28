// services/finance/src/bank/sepa-backend.ts
// TASK-009 lane C / R23-7 — leaf port of
// gremion-ui/.../services/money/sepa-backend.ts#SepaJsBackend. Builds a SEPA
// pain.001.001.09 XML document via the same `sepa` npm package (kewisch/sepa.js)
// the native oracle uses, so the wire format is byte-identical regardless of
// which FinanceBackend produced it. Externalised in the esbuild bundle (same
// treatment as exceljs/papaparse — see package.json's build script) and shipped
// as a production dependency in the runner image.
//
// Money on the wire is decimal-string EUR (e.g. "123.45"); the store passes
// integer euro-cents and this module converts at the boundary.

export interface SepaPayment {
  readonly endToEndId: string
  readonly amountCents: number
  readonly creditorName: string
  readonly creditorIban: string
  readonly creditorBic: string | null
  readonly remittanceInformation: string
  readonly postalAddress: { townName: string; country: string }
}

export interface SepaBatch {
  readonly messageId: string
  readonly creationDateTime: string
  readonly initiatingParty: { name: string }
  readonly debtor: {
    name: string
    iban: string
    bic: string | null
    postalAddress: { townName: string; country: string }
  }
  readonly requestedExecutionDate: string
  readonly payments: readonly SepaPayment[]
}

export interface SepaBackend {
  build(batch: SepaBatch): Promise<string>
}

/** Production backend backed by the `sepa` npm package. Dynamic import keeps
 *  this module unit-testable (a fake SepaBackend can be injected) without
 *  pulling the sepa ESM/CJS interop into every importer. */
export class SepaJsBackend implements SepaBackend {
  async build(batch: SepaBatch): Promise<string> {
    const sepaMod: unknown = await import('sepa')
    const SEPA = (sepaMod as { default?: unknown }).default ?? sepaMod
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const doc = new (SEPA as any).Document('pain.001.001.09')
    doc.grpHdr.id = batch.messageId
    doc.grpHdr.created = new Date(batch.creationDateTime)
    doc.grpHdr.initiatorName = batch.initiatingParty.name
    const info = doc.createPaymentInfo()
    info.requestedExecutionDate = new Date(batch.requestedExecutionDate)
    info.debtorName = batch.debtor.name
    info.debtorIBAN = batch.debtor.iban
    if (batch.debtor.bic) info.debtorBIC = batch.debtor.bic
    for (const p of batch.payments) {
      const tx = info.createTransaction()
      tx.creditorName = p.creditorName
      tx.creditorIBAN = p.creditorIban
      if (p.creditorBic) tx.creditorBIC = p.creditorBic
      tx.amount = p.amountCents / 100
      tx.remittanceInfo = p.remittanceInformation
      tx.end2endId = p.endToEndId
      info.addTransaction(tx)
    }
    doc.addPaymentInfo(info)
    return doc.toString() as string
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
}
