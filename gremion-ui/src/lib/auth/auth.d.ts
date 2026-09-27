declare module '@auth/core/types' {
  interface Session {
    /** Server-side only — never returned to browser in load() data. */
    accessToken?: string
    /** Unix-epoch ms access-token expiry. Server-side only (instrumentation). */
    accessTokenExpires?: number
    user: {
      roles?: import('$lib/auth/types').Role[]
      groups?: string[]
      // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- self-referential module augmentation: oxlint's type-aware pass resolves this same-module `import('@auth/core/types').DefaultSession['user']` to `any` while type-checking this very augmentation; svelte-check/tsc resolve it fine downstream. Left unchanged (R25 refactor lane is behaviour-preserving) — restructuring risks the app-wide Session/User typing.
    } & import('@auth/core/types').DefaultSession['user']
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    accessToken?: string
    accessTokenExpires?: number
    refreshToken?: string
    roles?: import('$lib/auth/types').Role[]
    groups?: string[]
    error?: string
  }
}
