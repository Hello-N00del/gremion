// src/lib/server/module-off-response.ts
// The response for a PAGE request whose owning module is switched off.
//
// Why not throw error(403) from the root +layout.server.ts load: SvelteKit renders the static
// error template (src/error.html / its built-in fallback), NOT routes/+error.svelte inside
// +layout.svelte, when the ROOT layout load fails. The person then sees "403 | module-disabled:files"
// on white, no shell. So the gate lives here, in the handle hook, BEFORE any route resolves:
//   - the disabled module's own page/layout server loads never run (nothing from it reaches the client,
//     also not via /<path>/__data.json);
//   - a document request is answered with the real, ordinary page routes/module-off/[id] (rendered inside
//     the root layout, so the app shell + brand are there), fetched in-process and returned with status 403;
//   - a client-side navigation's __data.json request gets a JSON 403 whose body is the message string.
//     SvelteKit's client turns that into a 403 error rendered by +error.svelte inside the already-loaded
//     root layout (shell stays); no blank page, no loop.
import type { RequestEvent } from '@sveltejs/kit'
import { base } from '$app/paths'

export const MODULE_OFF_PREFIX = 'module-disabled:'

export async function moduleOffPageResponse(event: RequestEvent, moduleId: string): Promise<Response> {
  const method = event.request.method
  if (event.isDataRequest) {
    return new Response(JSON.stringify(`${MODULE_OFF_PREFIX}${moduleId}`), {
      status: 403,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
  if (method !== 'GET' && method !== 'HEAD') return new Response('Module disabled', { status: 403 })
  try {
    // The sub-request must resolve the SAME tenant as the outer one. tenantForwardFetch only stamps the
    // host-trust headers when INTERNAL_PUSH_SECRET is configured, so carry the edge-injected host (and its
    // proxy-trust proof, already validated on the outer request) over explicitly; absent -> not set.
    const headers: Record<string, string> = { accept: event.request.headers.get('accept') ?? 'text/html' }
    for (const name of ['x-forwarded-host', 'x-proxy-trust']) {
      const v = event.request.headers.get(name)
      if (v) headers[name] = v
    }
    const inner = await event.fetch(`${base}/module-off/${encodeURIComponent(moduleId)}`, { headers })
    if (inner.status === 200) {
      const headers = new Headers(inner.headers)
      headers.set('cache-control', 'no-store')
      headers.delete('content-length')
      return new Response(method === 'HEAD' ? null : inner.body, { status: 403, headers })
    }
    console.warn(`[module-off] notice route answered ${inner.status}; serving the bare 403`)
  } catch (err) {
    console.warn('[module-off] notice route fetch failed; serving the bare 403:', err)
  }
  return new Response('Module disabled', { status: 403 })
}
