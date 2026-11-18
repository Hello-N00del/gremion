// Test helper for the WCAG 3.1.2 guards (locale-en): which text of a page rendered in
// the person's locale is not under an element that says so.
//
// A page declared in one language (<html lang="de">) renders its catalogue strings in the
// person's locale (i18n-handle.ts). Those strings differ between the two renders of the same
// page; every fragment that differs must sit under an element carrying the person's lang.
// A fragment that is the same in both renders (a name, a number, a hard-coded German
// sentence) is not catalogue text and is not judged here.
import { JSDOM } from 'jsdom'

export interface Fragment {
  text: string
  /** The nearest lang attribute above the fragment, the page's own included. */
  lang: string | null
  where: string
}

const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt']

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Every visible text node and every text-bearing attribute of `html`, with the lang that governs it. */
export function fragmentsOf(html: string, declared = 'de'): Fragment[] {
  const { window } = new JSDOM(`<!doctype html><html lang="${declared}"><body>${html}</body></html>`) as unknown as { window: Window & typeof globalThis }
  const { document } = window
  const out: Fragment[] = []
  const describe = (el: Element) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''
    return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}>`
  }
  const walker = document.createTreeWalker(document.body, window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      const el = node.parentElement
      if (!el || el.closest('script, style, template')) continue
      const text = norm(node.textContent ?? '')
      if (text) out.push({ text, lang: el.closest('[lang]')?.getAttribute('lang') ?? null, where: describe(el) })
    } else {
      const el = node as Element
      for (const a of ATTRIBUTES) {
        const v = norm(el.getAttribute(a) ?? '')
        if (v) out.push({ text: v, lang: el.closest('[lang]')?.getAttribute('lang') ?? null, where: `${describe(el)}[${a}]` })
      }
    }
  }
  return out
}

/** The fragments of `localizedHtml` that render differently than in `declaredHtml`: the catalogue text. */
export function catalogueText(declaredHtml: string, localizedHtml: string): Fragment[] {
  const same = new Set(fragmentsOf(declaredHtml).map((f) => f.text))
  return fragmentsOf(localizedHtml).filter((f) => !same.has(f.text))
}

/** The catalogue text of `localizedHtml` that is not under an element with lang `want`. */
export function unmarkedCatalogueText(declaredHtml: string, localizedHtml: string, want: string): Fragment[] {
  return catalogueText(declaredHtml, localizedHtml).filter((f) => f.lang !== want)
}
