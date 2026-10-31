// What the customer status page says about a request (shared by server and client).

/**
 * A8: a host-origin request is the audited break-glass path and is flagged as such.
 * A council-origin request is a self-service module switch by the council's own admin.
 */
export function originLabel(origin: string): string {
  if (origin === 'host') return 'Break-glass'
  if (origin === 'council') return 'Gremium'
  return 'Panel'
}
