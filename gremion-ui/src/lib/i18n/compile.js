// TASK-062: compiles the catalogue without a Vite run (used by `pnpm check`,
// which type-checks src/ and needs the generated modules to exist).
import { compile } from '@inlang/paraglide-js'
import options from './paraglide-options.js'

await compile(options)
