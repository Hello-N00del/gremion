// TASK-080-a step e: the `kernel-api bodies` dispatcher's argument contract.
// The verbs' effect on a real database is test/bodies/proof.int.test.ts.
import { describe, expect, it } from 'vitest'
import { runBodiesCli } from '../../src/bodies/cli.ts'

const A = '0192f0c1-2b3c-7d4e-8f00-1122334455aa'
const OP = '0192f0c1-2b3c-7d4e-8f00-1122334455ee'

async function run(argv: string[], open?: Parameters<typeof runBodiesCli>[3]) {
  const out: string[] = []
  const err: string[] = []
  const code = await runBodiesCli(argv, {}, { out: (l) => out.push(l), err: (l) => err.push(l) }, open)
  return { code, out, err }
}

describe('kernel-api bodies: usage', () => {
  it.each([
    [[], 'no verb'],
    [['status'], '--customer'],
    [['status', '--customer', 'not-a-uuid'], '--customer'],
    [['frobnicate', '--customer', A], 'unknown verb'],
    [['create-body', '--customer', A], '--operator'],
    [['create-body', '--customer', A, '--operator', 'x', '--json', '{}'], '--operator'],
    [['create-body', '--customer', A, '--operator', OP], '--operator'],
    [['status', '--customer', A, '--customer', A], 'twice'],
    [['status', '--customer', A, '--bogus', '1'], 'unknown flag'],
  ])('%j -> exit 2 naming the problem (nothing is opened)', async (argv, needle) => {
    let opened = false
    const r = await run(argv as string[], { open: async () => { opened = true; throw new Error('must not open') } })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain(needle)
    expect(opened).toBe(false)
  })

  it('invalid --json is a usage error after the customer was opened and closed again', async () => {
    let closed = false
    const r = await run(['create-body', '--customer', A, '--operator', OP, '--json', '{nope'], { open: async () => ({ sql: {} as never, close: async () => void (closed = true) }) })
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('not valid JSON')
    expect(closed).toBe(true)
  })

  it('a customer that cannot be opened is exit 1 with the reason, never a stack trace', async () => {
    const r = await run(['status', '--customer', A], { open: async () => { throw new Error('customer is suspended: nothing was done') } })
    expect(r.code).toBe(1)
    expect(r.err).toEqual(['kernel-api bodies: customer is suspended: nothing was done'])
  })

  it('without KERNEL_API_CONTROL_DB_URL the default opener refuses before connecting', async () => {
    const r = await run(['status', '--customer', A])
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('KERNEL_API_CONTROL_DB_URL is not set')
  })
})
