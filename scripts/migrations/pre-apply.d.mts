// Types for pre-apply.mjs (TASK-029): the chain-wide TASK-020 preApply hook.
export class ChainRefusal extends Error {
  code: string
  files: string[]
}

export function migrationNumber(file: string): number

export function chainFileNames(chainId: string, o: { root: string; register?: unknown }): string[]

export function chainPreApply(o: {
  chainFiles: string[]
  catchUp?: Iterable<string>
  log?: (line: string) => void
}): (file: string, ctx: { applied: readonly string[]; pending: readonly string[] }) => void
