// services/content/src/instagram/credentials.ts
//
// Instagram credentials seam — disabled-by-default.
//
// Returns null when not configured (the default for all environments until
// IG credentials are explicitly provisioned). The adapter and drain use this
// as the NotConfigured gate: when null, publish ops are marked failed
// immediately rather than being sent to the Meta Graph API.
//
// Env vars (all required to be "configured"):
//   IG_PAGE_ACCESS_TOKEN   — Meta Graph page access token
//   IG_INSTAGRAM_ACCOUNT_ID — Instagram Business Account ID
//   PUBLIC_BASE_URL        — used to build public slide URLs

export interface InstagramCredentials {
  pageAccessToken: string
  instagramAccountId: string
  publicBaseUrl: string
}

/**
 * Resolve Instagram credentials from environment variables.
 * Returns null when any required variable is unset — the NotConfigured state.
 * Production gate: all three env vars must be present and non-empty.
 */
export function resolveInstagramCredentials(env?: NodeJS.ProcessEnv): InstagramCredentials | null {
  const src = env ?? process.env
  const pageAccessToken = src['IG_PAGE_ACCESS_TOKEN']?.trim()
  const instagramAccountId = src['IG_INSTAGRAM_ACCOUNT_ID']?.trim()
  const publicBaseUrl = src['PUBLIC_BASE_URL']?.trim()

  if (!pageAccessToken || !instagramAccountId || !publicBaseUrl) {
    return null
  }

  return { pageAccessToken, instagramAccountId, publicBaseUrl }
}

/**
 * Given a public base URL and a post/slide reference, resolve the public URL
 * for a carousel slide PNG. Returns null when credentials are not configured
 * (the NotConfigured seam: drain calls this and marks the op failed on null).
 */
export function resolvePublicSlideUrls(
  credentials: InstagramCredentials | null,
  postId: string,
  slideCount: number,
): string[] | null {
  if (!credentials) return null
  const base = credentials.publicBaseUrl.replace(/\/+$/, '')
  return Array.from({ length: slideCount }, (_, i) =>
    `${base}/api/content/slides/${postId}/${i}.png`,
  )
}
