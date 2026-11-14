// The browser tab title: "<page> – <organisation> – <product>".
//
// The page comes first because a narrow tab shows only the start. The
// organisation name is what tells two installations apart in a tab strip or in
// the history; the product closes the title. A name that would appear twice
// (an installation whose organisation name is not set falls back to the product
// placeholder) is written once.
import type { Brand } from '$lib/brand'

const SEPARATOR = ' – '

export function documentTitle(segment: string | undefined, brand: Pick<Brand, 'orgName' | 'product'>): string {
  const parts: string[] = []
  for (const raw of [segment, brand.orgName, brand.product]) {
    const part = raw?.trim()
    if (!part) continue
    if (parts.some((p) => p.toLocaleLowerCase('de') === part.toLocaleLowerCase('de'))) continue
    parts.push(part)
  }
  return parts.join(SEPARATOR)
}
