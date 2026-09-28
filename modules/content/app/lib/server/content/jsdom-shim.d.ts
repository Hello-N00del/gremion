// Ambient declaration for the untyped `jsdom` import in segment.ts, caption.ts
// and channels/instagram-renderer.ts (TASK-200). It replaces their
// expect-error suppression lines, which the kernel toolchain guard allows only
// in *.test.ts. The constructor returns `unknown` on purpose: each caller already
// narrows the instance to its own local `JsdomInstance` shape, so nothing here
// widens anything to `any`. Delete this file if `@types/jsdom` is ever added.
declare module 'jsdom' {
	export const JSDOM: new (html?: string, options?: Record<string, unknown>) => unknown
}
