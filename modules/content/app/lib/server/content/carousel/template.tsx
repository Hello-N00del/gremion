// Content Engine (Pillar-1 kernel) — the carousel slide TEMPLATE.
//
// =============================================================================
//  CLAUDE DESIGN HAND-OFF CONTRACT
// -----------------------------------------------------------------------------
//  This file is the agreed seam between the content engine and Claude Design.
//  L1 ships a deliberately PLAIN, functional 1080x1080 placeholder so the whole
//  satori -> SVG -> PNG pipeline is proven end-to-end. Claude Design later
//  replaces ONLY the visual body of `SlideTemplate` — it must keep:
//
//    * the exported `SlideTemplateProps` shape (brandTokens + slide),
//    * the `SlideTemplate(props): JSX.Element` signature,
//    * satori constraints: flexbox layout only (NO CSS grid, floats, or
//      unsupported properties); every element with >1 child MUST set
//      `display: 'flex'`; explicit width/height; inline style objects only.
//
//  satori does not run React — it walks plain `{ type, props }` nodes. We build
//  those nodes with a tiny local `h()` hyperscript instead of JSX angle-bracket
//  syntax, so this `.tsx` file needs NO `jsx` compiler option, NO `react`
//  dependency, and NO project-wide JSX runtime. `SlideTemplate(props)` returns a
//  node satori accepts directly, typed as the local `JSX.Element`.
// =============================================================================

import type { SlideModel } from '../channels/types'

/** Per-tenant brand tokens passed in by the render layer (from config.brand). */
export interface SlideTemplateProps {
	brandTokens: { accent: string; logoUrl: string | null }
	slide: SlideModel
}

// --- minimal satori-compatible hyperscript -----------------------------------
// satori reads `.type` (tag name string) and `.props` (incl. `children`). This
// is intentionally tiny; it is NOT a React renderer.

/** A satori element node: a tag plus its props (style + children). */
export interface SatoriElement {
	type: string
	props: Record<string, unknown> & { children?: unknown }
}

type Child = SatoriElement | string | number | null | undefined | boolean
type Children = Child | Child[]

/** Hyperscript factory: build a satori node from a tag, props, and children. */
function h(
	type: string,
	props: Record<string, unknown> | null,
	...children: Children[]
): SatoriElement {
	const flat = children
		.flat()
		.filter((c): c is SatoriElement | string | number => c !== null && c !== undefined && c !== false)
	const merged: Record<string, unknown> = { ...props }
	if (flat.length === 1) merged.children = flat[0]
	else if (flat.length > 1) merged.children = flat
	return { type, props: merged }
}

// Local JSX typing so `SlideTemplate(props): JSX.Element` resolves with no
// global React/JSX runtime present. (We never use angle-bracket JSX syntax, so
// `IntrinsicElements` is unused, but the namespace makes `JSX.Element` valid.)
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace JSX {
	type Element = SatoriElement
}

const PX = 1080

/**
 * A plain placeholder slide: an accent header bar, an optional image box, the
 * heading, the body text, and an index/total footer. 1080x1080. Pure — no I/O.
 *
 * Claude Design replaces the visual body only; the signature + props are locked.
 */
export function SlideTemplate(props: SlideTemplateProps): JSX.Element {
	const { brandTokens, slide } = props
	const accent = brandTokens.accent || '#222222'
	const footer = `${slide.index + 1} / ${slide.total}`

	// L1 placeholder: render a labelled IMAGE BOX (a plain div), never a real
	// <img>. Embedding `slide.imageUrl` as an <img> would force satori to fetch
	// the remote image to measure it — a network dependency L1 forbids (renders
	// must be in-process and browser-free). Claude Design wires the real image in
	// a later handover; the box reserves the layout and shows the source.
	const imageBox: SatoriElement | null = slide.imageUrl
		? h(
				'div',
				{
					style: {
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '100%',
						height: '420px',
						marginBottom: '48px',
						backgroundColor: '#eeeeee',
						color: '#999999',
						fontSize: '28px',
					},
				},
				'image',
			)
		: null

	const headingBox: SatoriElement | null = slide.heading
		? h(
				'div',
				{
					style: {
						display: 'flex',
						fontSize: slide.kind === 'cover' ? '88px' : '64px',
						fontWeight: 700,
						lineHeight: 1.1,
						marginBottom: '32px',
					},
				},
				slide.heading,
			)
		: null

	const bodyBox: SatoriElement | null = slide.body
		? h(
				'div',
				{
					style: { display: 'flex', fontSize: '40px', lineHeight: 1.4, color: '#333333' },
				},
				slide.body,
			)
		: null

	return h(
		'div',
		{
			style: {
				display: 'flex',
				flexDirection: 'column',
				width: `${PX}px`,
				height: `${PX}px`,
				backgroundColor: '#ffffff',
				fontFamily: 'Inter',
				color: '#111111',
			},
		},
		// accent header bar
		h('div', {
			style: { display: 'flex', width: '100%', height: '24px', backgroundColor: accent },
		}),
		// body region
		h(
			'div',
			{ style: { display: 'flex', flexDirection: 'column', flexGrow: 1, padding: '72px' } },
			imageBox,
			headingBox,
			bodyBox,
		),
		// footer: index/total + an accent rule
		h(
			'div',
			{
				style: {
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					width: '100%',
					padding: '0 72px 48px 72px',
					fontSize: '32px',
					color: '#888888',
				},
			},
			h('div', { style: { display: 'flex' } }, footer),
			h('div', {
				style: { display: 'flex', width: '120px', height: '8px', backgroundColor: accent },
			}),
		),
	)
}
