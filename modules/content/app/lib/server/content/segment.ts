// Content Engine (Pillar-1 kernel) — pure, deterministic <h2> segmentation.
//
// The authored body_html is a single sanitized rich-HTML string (see
// html-sanitize.ts; <h2> is allow-listed and is the structural delimiter).
// The channel renderers (email/portal/instagram) all need the body split
// into sections — one block of intro before the first <h2>, then one section
// per <h2> heading running until the next <h2>. This splitter is the single
// source of that structure so every channel sees identical sections.
//
// Implementation note: we parse with jsdom (a direct dependency) rather than a
// global DOMParser so the function behaves identically under Node SSR and the
// jsdom unit-test env. It is pure: same input → deep-equal output, no I/O.

// `jsdom` ships no type declarations and we deliberately add no `@types/jsdom`
// dependency for this pure helper. We import it untyped and re-type its window
// to the standard DOM lib types (the tsconfig includes "DOM") so the rest of the
// function is fully typed. jsdom is used (rather than a global DOMParser, which
// is not a Node runtime global) so the splitter behaves identically under
// SvelteKit SSR and the jsdom unit-test env.
// Typed by the local ambient declaration in jsdom-shim.d.ts (the toolchain guard allows
// the expect-error suppression directive only in *.test.ts).
import { JSDOM } from 'jsdom'

interface JsdomWindow {
	document: Document
	Node: typeof Node
}
interface JsdomInstance {
	window: JsdomWindow
}

/** One segment of a post body. `heading` is '' for the lead/intro block. */
export interface Section {
	heading: string
	html: string
}

/**
 * Split sanitized `bodyHtml` into sections on top-level `<h2>` boundaries.
 *
 * - Content before the first `<h2>` becomes a lead section `{ heading: '', html }`.
 * - Each `<h2>` opens a new section; its `heading` is the `<h2>` text content
 *   (trimmed, inline tags flattened); its `html` is the run of sibling nodes
 *   after the `<h2>` up to (not including) the next `<h2>`.
 * - An empty / whitespace-only body returns `[]`.
 *
 * Pure and deterministic — no network, filesystem, clock, or randomness.
 */
export function segmentBody(bodyHtml: string): Section[] {
	if (!bodyHtml || bodyHtml.trim() === '') return []

	const { window } = new JSDOM('<!DOCTYPE html><body></body>') as JsdomInstance
	const doc = window.document
	doc.body.innerHTML = bodyHtml

	const sections: Section[] = []
	// The lead (intro) block — html accumulated before any <h2>.
	let leadHtml = ''
	// The section currently being filled (after we have seen an <h2>), or null
	// while we are still in the lead.
	let current: { heading: string; html: string } | null = null

	const flush = (): void => {
		if (current) {
			sections.push({ heading: current.heading, html: current.html.trim() })
			current = null
		}
	}

	for (const node of Array.from(doc.body.childNodes)) {
		const isH2 =
			node.nodeType === window.Node.ELEMENT_NODE &&
			(node as Element).tagName.toLowerCase() === 'h2'

		if (isH2) {
			// Close out whatever section preceded this <h2>.
			flush()
			const heading = (node.textContent ?? '').trim()
			current = { heading, html: '' }
			continue
		}

		const outer =
			node.nodeType === window.Node.ELEMENT_NODE
				? (node as Element).outerHTML
				: node.nodeType === window.Node.TEXT_NODE
					? (node.textContent ?? '')
					: ''

		if (current) {
			current.html += outer
		} else {
			leadHtml += outer
		}
	}

	flush()

	const trimmedLead = leadHtml.trim()
	if (trimmedLead !== '') {
		sections.unshift({ heading: '', html: trimmedLead })
	}

	return sections
}
