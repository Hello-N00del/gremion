import { decodeJwt } from 'jose'

/**
 * Result of a safe access-token decode.
 *
 * On success, callers receive the extracted claims slice they need (raw realm
 * roles, sub, groups, preferred_username). On failure, the typed `error`
 * branch is returned so the refresh handler can surface a session error and
 * force re-login — never silently fall back to `{}` (which would reset the
 * user's roles to Guest while the rest of the session continues).
 *
 * G-018: Replaces the previous silent-`{}` try/catch around manual base64
 * payload parsing.
 */
export type DecodedAccessToken =
  | {
      realmRoles: string[]
      sub?: string
      groups: string[]
      preferredUsername?: string
      acr?: string
      authTime?: number
      iss?: string // CR2: the token issuer (realm), for the iss-match backstop
      /**
       * P2.2-auth A3 (design §3.5(e), D-VOCAB): the tenant role vocabulary the
       * caller threaded in — passed through UNTOUCHED so the downstream filter
       * sites consume one tenant-resolved source. The extraction itself is NOT
       * filtered by it (decode feeds the filters; it is not one). Absent when
       * the caller passed none, keeping the default path byte-identical.
       */
      vocabulary?: readonly string[]
    }
  | { error: 'TokenDecodeFailed' }

/**
 * Decode a Keycloak access token payload using `jose.decodeJwt` (no signature
 * verification — issuer verification is handled upstream by Auth.js). Returns
 * a discriminated union; callers MUST handle the `error` branch.
 *
 * P2.2-auth A3: `vocabulary` is the CURRENT tenant's role vocabulary, threaded
 * from the caller (src/auth.ts resolves it per request). It rides through to
 * the result verbatim and never filters `realmRoles` — extraction semantics
 * are tenant-INDEPENDENT by design (§3.5(e)).
 */
export function safeDecodeAccessToken(
  token: string,
  vocabulary?: readonly string[],
): DecodedAccessToken {
  if (!token) return { error: 'TokenDecodeFailed' }
  try {
    const claims = decodeJwt(token)
    const realmRoles =
      (claims['realm_access'] as { roles?: string[] } | undefined)?.roles ?? []
    return {
      realmRoles,
      sub: claims.sub,
      groups: (claims['groups'] as string[] | undefined) ?? [],
      preferredUsername: claims['preferred_username'] as string | undefined,
      acr: claims['acr'] as string | undefined,
      authTime:
        typeof claims['auth_time'] === 'number'
          ? (claims['auth_time'] as number)
          : undefined,
      iss: claims.iss,
      // Conditional spread: the no-vocabulary result must carry NO extra key
      // (default path byte-identical — toStrictEqual-pinned in decode.test.ts).
      ...(vocabulary !== undefined ? { vocabulary } : {}),
    }
  } catch {
    return { error: 'TokenDecodeFailed' }
  }
}
