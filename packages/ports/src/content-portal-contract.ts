// packages/ports/src/content-portal-contract.ts (@gremion/ports/content-portal-contract)
//
// The SINGLE shared fixture that pins the portal-publish callback envelope across
// the content leaf → kernel HTTP seam (POST /api/internal/content/portal-publish).
// Both sides depend on THIS one object, so envelope drift on either side fails the
// build rather than surfacing as a runtime 400/500 in production:
//
//   - MODULE (the content module's kernel client, in the module repo): portalPublish() must serialize
//            its POST body to exactly PORTAL_PUBLISH_CONTRACT.request. The leaf spec
//            drives the REAL portalPublish and asserts the captured body deep-equals
//            the fixture.
//   - KERNEL (gremion-ui .../portal-publish/+server.ts): a POST of that same fixture
//            body must return a JSON object whose keys are exactly
//            PORTAL_PUBLISH_CONTRACT.responseKeys. The kernel contract spec drives the
//            REAL +server.ts POST (portalCallback mocked) and asserts the response keys.
//
// Dependency-free by design (a plain data module) so it can live in @gremion/ports
// and be imported by both the monolith (noExternal'd) and the standalone leaf.

/** The request body the leaf POSTs to /api/internal/content/portal-publish. */
export interface PortalPublishRequest {
  /** UUID of the content-service post — the kernel's idempotency anchor. */
  contentPostId: string
  title: string
  bodyHtml: string
}

/**
 * The canonical portal-publish envelope. `request` is what the leaf sends when it
 * has no prior externalRef (the common first-publish path); `responseKeys` is the
 * exact set of top-level keys the kernel returns on a 200.
 */
export const PORTAL_PUBLISH_CONTRACT = {
  /**
   * Canonical request envelope. `contentPostId` is a valid RFC-4122-shaped UUID so
   * the kernel's format-only UUID guard accepts the fixture unchanged.
   */
  request: {
    contentPostId: '11111111-1111-1111-1111-111111111111',
    title: 'Portal Publish Contract Fixture',
    bodyHtml: '<p>contract body</p>',
  } as PortalPublishRequest,
  /** The exact top-level keys the kernel returns in its 200 JSON body. */
  responseKeys: ['id', 'slug', 'published_at', 'content_origin_post_id'] as const,
} as const
