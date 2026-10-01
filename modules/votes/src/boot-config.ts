// modules/votes/src/boot-config.ts
// Fatal boot-config checks for the votes leaf. Returns one human-readable line
// per problem; the entrypoint prints them and exits non-zero.
//
// K5#29 / S4#18: the leaf talks to Nextcloud Polls with the admin Basic
// credential. An unset password used to fall back to '' and every poll call then
// failed at runtime as an opaque 401, long after boot looked healthy.

export function bootConfigProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = []
  if (!env.NEXTCLOUD_ADMIN_PASSWORD || env.NEXTCLOUD_ADMIN_PASSWORD.trim() === '') {
    problems.push('NEXTCLOUD_ADMIN_PASSWORD is empty or unset - the leaf cannot authenticate to Nextcloud Polls')
  }
  return problems
}
