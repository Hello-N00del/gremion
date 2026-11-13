// Which pathnames get the app shell (rail, top bar, overlays) around the page.
//
// The kernel's own bare pages (sign-in, legal, first-run setup) are listed here. A feature module can ask for
// further bare routes through its layout slot (`bareRoutes`, see $lib/modules/layout-slot.ts) without the kernel
// naming a module path: the files module asks for its full-viewport document editor.
const KERNEL_BARE_PREFIXES = ['/auth', '/legal', '/setup'] as const

/** True when `pathname` is `prefix` itself or lies below it (`/files/edit` matches `/files/edit/a.odt`, not `/files/editor`). */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

export function isShellPath(pathname: string, moduleBareRoutes: readonly string[] = []): boolean {
  if (KERNEL_BARE_PREFIXES.some((p) => pathname.startsWith(p))) return false
  return !moduleBareRoutes.some((p) => under(pathname, p))
}
