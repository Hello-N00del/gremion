// TRD-092 / TRD-191 / PRD-OPS-006: every operator action on a customer through
// this panel is one row of the vendor-access record (oac.access_record in
// gremion_platform: who, when, what, why), which that customer's council
// administrator reads inside the product. The row is written by
// oac.record_access, in the SAME statement as the request it belongs to
// (requests.ts submitCreate, retry.ts retryRequest, customer-request.ts queueRequest): the request is refused when
// its record cannot be written, and no record exists for a refused request. The
// panel's role holds EXECUTE on that one function and no table privilege.
//
// `who` is the operator's uuid (the function checks it is one; the role's marker
// membership says origin = panel); `when` is the server clock.

export interface AccessWords {
  action: string
  what: string
  why: string
}

/** What the council administrator reads for a panel action (German, free of secrets and of request args). */
export function accessWords(kind: string, slug: string, retry: boolean): AccessWords {
  const verb = kind === 'create' ? 'Mandant anlegen' : `Anfrage ${kind}`
  return {
    action: retry ? 'panel_retry_request' : 'panel_request',
    what: retry
      ? `${verb} für ${slug}: erneuter Versuch einer fehlgeschlagenen Anfrage (Provisionierung der Mandantendaten)`
      : `${verb} für ${slug}: Anfrage zur Provisionierung der Mandantendaten gestellt`,
    why: retry
      ? 'Betreiber-Anforderung im Control-Panel (erneuter Versuch, Anmeldung mit loa2)'
      : 'Betreiber-Anforderung im Control-Panel (Anmeldung mit loa2)',
  }
}
