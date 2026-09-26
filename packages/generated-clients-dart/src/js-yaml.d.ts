// Minimal ambient types for the one js-yaml function this package calls.
// js-yaml 4.3.2 is already in the workspace lockfile (reused rather than adding
// @types/js-yaml, which would pull a new package into the lockfile).
declare module 'js-yaml' {
  export function load(input: string): unknown
}
