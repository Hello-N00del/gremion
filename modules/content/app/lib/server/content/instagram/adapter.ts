// Content Engine L3 — Meta Graph carousel publish adapter.
//
// Publishing an Instagram carousel is a 3-step Graph dance:
//   1. For EACH slide: POST /{ig-user-id}/media?image_url=<public>&is_carousel_item=true
//      → an image-container creation id.
//   2. POST /{ig-user-id}/media?media_type=CAROUSEL&children=<ids,csv>&caption=<text>
//      → a carousel-container creation id.
//   3. POST /{ig-user-id}/media_publish?creation_id=<carousel id>
//      → the published media id (returned).
//
// Meta INGESTS each slide image from a public HTTPS URL (it fetches the URL
// itself), so producing those public, expiring slide URLs is an ACTIVATION
// concern handled by the caller (the drain) — this adapter just takes the URLs.
//
// `fetch` is injectable so the whole thing is unit-testable with NO network.
import type { InstagramCredentials } from './credentials'

/** A single carousel slide as a public HTTPS URL Meta will fetch. */
export interface SlideUpload {
  imageUrl: string
}

export interface InstagramAdapter {
  /** Publish a carousel; resolves to the published Meta media id. Throws on any failing step. */
  publishCarousel(
    creds: InstagramCredentials,
    slides: SlideUpload[],
    caption: string,
  ): Promise<{ mediaId: string }>
}

/** Meta Graph API version this adapter targets. */
const GRAPH_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

interface GraphIdResponse {
  id?: string
}
interface GraphErrorResponse {
  error?: { message?: string; type?: string; code?: number }
}

/** POST to a Graph edge with query params; return the parsed `{ id }` or throw the Meta error. */
async function graphPost(
  fetchImpl: typeof fetch,
  igUserId: string,
  edge: string,
  params: Record<string, string>,
): Promise<string> {
  const qs = new URLSearchParams(params).toString()
  const url = `${GRAPH_BASE}/${igUserId}/${edge}?${qs}`
  const res = await fetchImpl(url, { method: 'POST' })
  // Parse defensively — a non-JSON error body must still produce a clear throw.
  let body: (GraphIdResponse & GraphErrorResponse) | null = null
  try {
    body = (await res.json()) as GraphIdResponse & GraphErrorResponse
  } catch {
    body = null
  }
  if (!res.ok) {
    const msg = body?.error?.message ?? `HTTP ${res.status}`
    throw new Error(`Instagram Graph ${edge} failed: ${msg}`)
  }
  if (!body?.id) {
    throw new Error(`Instagram Graph ${edge} returned no id`)
  }
  return body.id
}

export function createInstagramAdapter(fetchImpl: typeof fetch = fetch): InstagramAdapter {
  return {
    async publishCarousel(creds, slides, caption) {
      if (slides.length === 0) {
        throw new Error('Instagram carousel requires at least one slide')
      }
      const token = creds.accessToken

      // Step 1 — one image container per slide (sequential: fail-fast on the first bad slide).
      const childIds: string[] = []
      for (const slide of slides) {
        const childId = await graphPost(fetchImpl, creds.igUserId, 'media', {
          image_url: slide.imageUrl,
          is_carousel_item: 'true',
          access_token: token,
        })
        childIds.push(childId)
      }

      // Step 2 — carousel container binding the children + caption.
      const carouselId = await graphPost(fetchImpl, creds.igUserId, 'media', {
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        caption,
        access_token: token,
      })

      // Step 3 — publish the carousel creation id.
      const mediaId = await graphPost(fetchImpl, creds.igUserId, 'media_publish', {
        creation_id: carouselId,
        access_token: token,
      })

      return { mediaId }
    },
  }
}
