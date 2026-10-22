// What the customer status page says about a request (shared by server and client).

/** A8: a host-origin request is the audited break-glass path and is flagged as such. */
export function originLabel(origin: string): string {
  return origin === 'host' ? 'Break-glass' : 'Panel'
}
