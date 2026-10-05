// Two (or more) local OIDC issuers for lane A (lane note A2): an RS256 key
// pair per realm and one stub JWKS server on 127.0.0.1 answering
// /realms/<realm>/protocol/openid-connect/certs -- the path the kernel API
// derives from a customer's kc_internal. Real Keycloak realms (and the
// audience mapper) are lane B's (TASK-077-b).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'

export interface Realm {
  name: string
  issuer: string
  kcInternal: string
  privateKey: CryptoKey
  jwk: JWK
}

export interface Issuers {
  realms: Map<string, Realm>
  /** JWKS fetches per realm (the cache test counts them). */
  fetches: Map<string, number>
  mint(realm: string, claims?: Record<string, unknown>, opts?: { alg?: string; exp?: string | number; nbf?: number; key?: CryptoKey | Uint8Array; kid?: string }): Promise<string>
  close(): Promise<void>
}

export async function startIssuers(names: string[]): Promise<Issuers> {
  const realms = new Map<string, Realm>()
  const fetches = new Map<string, number>()
  const server: Server = createServer((req, res) => {
    const m = /^\/realms\/([^/]+)\/protocol\/openid-connect\/certs$/.exec(req.url ?? '')
    const realm = m ? realms.get(m[1]!) : undefined
    if (!realm) {
      res.writeHead(404).end()
      return
    }
    fetches.set(realm.name, (fetches.get(realm.name) ?? 0) + 1)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [realm.jwk] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  for (const name of names) {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
    const jwk = { ...(await exportJWK(publicKey)), kid: `kid-${name}`, alg: 'RS256', use: 'sig' }
    realms.set(name, {
      name,
      // the public issuer (what Keycloak stamps into iss) and the internal base the JWKS is fetched from
      issuer: `https://${name}.example.org/realms/${name}`,
      kcInternal: `http://127.0.0.1:${port}/realms/${name}`,
      privateKey: privateKey as CryptoKey,
      jwk,
    })
  }
  return {
    realms,
    fetches,
    async mint(realmName, claims = {}, opts = {}) {
      const realm = realms.get(realmName)!
      const now = Math.floor(Date.now() / 1000)
      const jwt = new SignJWT({ aud: ['gremion-kernel-api', 'account'], azp: 'gremion-ui', ...claims })
        .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? realm.jwk.kid! })
        .setIssuer((claims.iss as string | undefined) ?? realm.issuer)
        .setSubject('person-1')
        .setIssuedAt(now)
        .setExpirationTime(opts.exp ?? now + 300)
      if (opts.nbf !== undefined) jwt.setNotBefore(opts.nbf)
      return jwt.sign(opts.key ?? realm.privateKey)
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
