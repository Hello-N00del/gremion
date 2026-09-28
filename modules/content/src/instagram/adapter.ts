// services/content/src/instagram/adapter.ts
//
// Meta Graph carousel adapter — disabled-by-default.
//
// Thin HTTP adapter over the Meta Graph API for Instagram carousel publishing.
// The adapter is injected with a fetchImpl so tests can exercise it without
// real network calls.
//
// In production this is wired only when resolveInstagramCredentials() returns
// non-null. When credentials are null the drain marks publish ops failed and
// never calls the adapter. The adapter itself has no knowledge of credentials:
// callers pass the token/account explicitly so it stays testable and stateless.
//
// Note: IG carousel creation is a 3-step process:
//   1. Upload each image as a container (POST /{account}/media?is_carousel_item=true)
//   2. Create a carousel container (POST /{account}/media?media_type=CAROUSEL)
//   3. Publish the carousel (POST /{account}/media_publish)

/** Minimal fetch shape (injectable for tests). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface InstagramCarouselInput {
  /** Instagram Business Account ID. */
  accountId: string
  /** Page access token. */
  accessToken: string
  /** Public URLs of each carousel slide image (must be reachable by Meta servers). */
  imageUrls: string[]
  /** Caption for the carousel post (plain text, max 2200 chars). */
  caption: string
}

export interface InstagramCarouselResult {
  /** The published Media ID from the Meta Graph API. */
  mediaId: string
}

const GRAPH_BASE = 'https://graph.facebook.com/v19.0'

/**
 * Create an Instagram carousel publisher bound to the given fetchImpl.
 * Pass `globalThis.fetch` in production, or a mock in tests.
 */
export function createInstagramAdapter(fetchImpl: FetchLike) {
  return {
    /**
     * Publish a carousel to Instagram via the Meta Graph API.
     * Throws on any API error (non-ok response).
     */
    async publishCarousel(input: InstagramCarouselInput): Promise<InstagramCarouselResult> {
      const { accountId, accessToken, imageUrls, caption } = input

      // Step 1: Create per-slide image containers.
      const itemIds: string[] = []
      for (const imageUrl of imageUrls) {
        const params = new URLSearchParams({
          image_url: imageUrl,
          is_carousel_item: 'true',
          access_token: accessToken,
        })
        const res = await fetchImpl(`${GRAPH_BASE}/${accountId}/media`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        })
        if (!res.ok) {
          const snippet = await res.text().catch(() => '')
          throw new Error(`IG media container failed: ${res.status} ${snippet.slice(0, 200)}`)
        }
        const data = (await res.json()) as { id?: unknown }
        if (typeof data.id !== 'string') {
          throw new Error('IG media container returned no id')
        }
        itemIds.push(data.id)
      }

      // Step 2: Create carousel container.
      const carouselParams = new URLSearchParams({
        media_type: 'CAROUSEL',
        caption,
        children: itemIds.join(','),
        access_token: accessToken,
      })
      const carouselRes = await fetchImpl(`${GRAPH_BASE}/${accountId}/media`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: carouselParams.toString(),
      })
      if (!carouselRes.ok) {
        const snippet = await carouselRes.text().catch(() => '')
        throw new Error(`IG carousel container failed: ${carouselRes.status} ${snippet.slice(0, 200)}`)
      }
      const carouselData = (await carouselRes.json()) as { id?: unknown }
      if (typeof carouselData.id !== 'string') {
        throw new Error('IG carousel container returned no id')
      }
      const carouselId = carouselData.id

      // Step 3: Publish the carousel.
      const publishParams = new URLSearchParams({
        creation_id: carouselId,
        access_token: accessToken,
      })
      const publishRes = await fetchImpl(`${GRAPH_BASE}/${accountId}/media_publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: publishParams.toString(),
      })
      if (!publishRes.ok) {
        const snippet = await publishRes.text().catch(() => '')
        throw new Error(`IG media_publish failed: ${publishRes.status} ${snippet.slice(0, 200)}`)
      }
      const publishData = (await publishRes.json()) as { id?: unknown }
      if (typeof publishData.id !== 'string') {
        throw new Error('IG media_publish returned no id')
      }

      return { mediaId: publishData.id }
    },
  }
}

export type InstagramAdapter = ReturnType<typeof createInstagramAdapter>
