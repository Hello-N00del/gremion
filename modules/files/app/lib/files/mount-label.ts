// A group folder's Nextcloud mount point carries its customer's namespace key as a suffix (" (<key>)",
// lib/server/files/namespace.ts). Members are shown the plain unit name: this removes the suffix again.
// Client-safe (no server imports): the file browser calls it while rendering.

/** `name` without `suffix` at its end; unchanged when it does not end in it, when there is no suffix, or when nothing would be left. */
export function stripMountSuffix(name: string, suffix: string): string {
  if (suffix === '' || !name.endsWith(suffix) || name.length === suffix.length) return name
  return name.slice(0, -suffix.length)
}
