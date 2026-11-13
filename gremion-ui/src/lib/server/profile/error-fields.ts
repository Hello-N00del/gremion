// What a profile-side log line may say about a failure: the error class and, for a
// Keycloak admin error, the HTTP status. Never the message, which can carry a response body.
// Matched by name, not instanceof, so a test double of the admin module needs no extra export.
export function errorFields(err: unknown): { error: string; status?: number } {
  const error = err instanceof Error ? err.name : typeof err
  if (err instanceof Error && err.name === 'KcAdminError') {
    const status = (err as Error & { status?: unknown }).status
    if (typeof status === 'number') return { error, status }
  }
  return { error }
}
