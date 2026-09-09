declare module '@auth/core/types' {
  interface Session {
    /** Server-side only — never returned to browser in load() data. */
    accessToken?: string
    /** Unix-epoch ms access-token expiry. Server-side only (instrumentation). */
    accessTokenExpires?: number
    user: {
      roles?: import('$lib/auth/types').Role[]
      groups?: string[]
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
