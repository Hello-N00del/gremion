// GET /api/content/posts/[id]/carousel/[index] — a single 1080x1080 slide PNG
// for the Instagram carousel preview (image/png). Read-gated (Role.Member);
// never cached (no-store) since it reflects the live edited post. Brand tokens
// (accent / logo) come from the current tenant's config.brand.
import { error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentRead } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'
import { instagramRenderer } from '$lib/server/content/channels/instagram-renderer'
import { renderSlidePng } from '$lib/server/content/carousel/render'
import { readConfig } from '$lib/server/config'
import { INSTANCE_REGISTRY, resolvePaletteId } from '$lib/theme/instance-theme'

export const GET: RequestHandler = async (event) => {
  requireContentRead(event.locals.user)

  const index = Number(event.params.index)
  if (!Number.isInteger(index) || index < 0) throw error(400, 'Invalid slide index')

  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const id = event.params.id
  const post = await backend.getPost(id)
  if (!post) throw error(404, 'Not found')

  const [media, channels] = await Promise.all([backend.listMedia(id), backend.getChannels(id)])
  const channelRow = channels.find((c) => c.channel === 'instagram')
  if (!channelRow) throw error(404, 'Channel not found')

  const preview = instagramRenderer.derive(post, media, channelRow)
  const slide = preview.slides[index]
  if (!slide) throw error(404, 'Slide not found')

  const brand = readConfig().brand
  // brand.palette is a CURATED instance id — NOT a raw CSS colour (config.ts
  // §brand). Passing it straight into satori's `backgroundColor` would render a
  // non-null tenant palette (e.g. 'stadt') as black. Resolve it against the
  // registry and hand satori a valid `hsl()` in the instance hue (satori parses
  // hsl reliably; oklch support is version-dependent; the registry's chroma
  // FACTOR is not representable in this hsl placeholder — the saturation
  // literal stays as-is). When it resolves to null (unset/invalid → default
  // theme) pass '' so the template keeps its own neutral placeholder fallback.
  // The exact slide palette is the designer's (this template is the §7
  // hand-off placeholder); this only makes the accent a valid, hue-correct
  // colour instead of black.
  const palette = resolvePaletteId(brand.palette)
  const accentColor = palette == null ? '' : `hsl(${INSTANCE_REGISTRY[palette].H} 45% 38%)`
  const png = await renderSlidePng({
    brandTokens: { accent: accentColor, logoUrl: brand.logo_url },
    slide,
  })

  // png is a Uint8Array; wrap in a fresh ArrayBuffer-backed Blob/body. Response
  // accepts a BodyInit; a Uint8Array is a valid BodyInit in the SvelteKit/undici
  // runtime, but copy to a standalone ArrayBuffer to avoid any shared-buffer
  // view surprises.
  const bytes = png.slice()
  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    },
  })
}
