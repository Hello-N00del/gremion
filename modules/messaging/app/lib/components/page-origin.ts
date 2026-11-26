// The origin of the page the call frame is shown on, or null when there is no page (server render).
// A function of its own so the server-render fallback can be tested without touching `window` itself.
export function pageOrigin(): string | null {
  return typeof window !== 'undefined' ? window.location.origin : null
}
