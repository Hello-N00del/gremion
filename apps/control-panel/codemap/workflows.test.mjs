// workflows.mjs: a small line scanner for the jobs of a GitHub workflow file. It has no YAML library, so the result
// is the same in git mode (CI) and in tree mode (the image). It must never throw.
import { describe, expect, it } from 'vitest'
import { parseJobs } from './workflows.mjs'

const byId = (jobs, id) => jobs.find((j) => j.id === id)

describe('parseJobs: job ids and names', () => {
  const text = [
    'name: Demo',
    'on: push',
    'jobs:',
    '  # a comment at the job level',
    '  lint:',
    '    name: Lint',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: A step name that is not a job name',
    '        run: echo hi',
    '  build:',
    '    name: "Build: the image"',
    '    runs-on: ubuntu-latest',
    "  matrixed:",
    "    name: Build ${{ matrix.name }}",
    '    runs-on: ubuntu-latest',
    '  bare:',
    '    runs-on: ubuntu-latest',
    '',
  ].join('\n')

  it('finds the job ids at indent 2, in order, with the line of each', () => {
    const jobs = parseJobs(text)
    expect(jobs.map((j) => j.id)).toEqual(['lint', 'build', 'matrixed', 'bare'])
    expect(byId(jobs, 'lint').line).toBe(5)
    expect(byId(jobs, 'bare').line).toBe(17)
  })

  it('reads name at indent 4, strips quotes, and ignores a name that holds an expression', () => {
    const jobs = parseJobs(text)
    expect(byId(jobs, 'lint').name).toBe('Lint')
    expect(byId(jobs, 'build').name).toBe('Build: the image')
    expect(byId(jobs, 'matrixed').name).toBe('')
    expect(byId(jobs, 'bare').name).toBe('')
  })

  it('does not take the name of a step', () => {
    expect(byId(parseJobs(text), 'bare').name).toBe('')
  })

  it('ignores keys above the jobs key and stops at the next top-level key', () => {
    const t = ['jobs:', '  a:', '    runs-on: x', 'env:', '  b:', '    name: nope', ''].join('\n')
    expect(parseJobs(t).map((j) => j.id)).toEqual(['a'])
  })

  it('keeps the first of two jobs with one id', () => {
    const t = ['jobs:', '  a:', '    name: One', '  a:', '    name: Two', ''].join('\n')
    const jobs = parseJobs(t)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].name).toBe('One')
  })
})

describe('parseJobs: needs', () => {
  it('reads a single value', () => {
    const jobs = parseJobs(['jobs:', '  a:', '    runs-on: x', '  b:', '    needs: a', ''].join('\n'))
    expect(byId(jobs, 'b').needs).toEqual(['a'])
    expect(byId(jobs, 'a').needs).toEqual([])
  })

  it('reads an inline list, with quotes and a comment', () => {
    const jobs = parseJobs(['jobs:', '  c:', '    needs: [a, "b", \'d\']  # why', ''].join('\n'))
    expect(byId(jobs, 'c').needs).toEqual(['a', 'b', 'd'])
  })

  it('reads a block list, skips comments and blank lines in it, and stops at the next key', () => {
    const t = [
      'jobs:',
      '  gate:',
      '    needs:',
      '      - lint',
      '      # a comment inside the list',
      '',
      '      - verify-static',
      '      - "verify-census"',
      '    # a comment after the list',
      "    if: ${{ always() }}",
      '    runs-on: x',
      '',
    ].join('\n')
    expect(byId(parseJobs(t), 'gate').needs).toEqual(['lint', 'verify-static', 'verify-census'])
  })

  it('does not take a needs key of a step or of a deeper level', () => {
    const t = ['jobs:', '  a:', '    steps:', '      - with:', '          needs: ghost', ''].join('\n')
    expect(byId(parseJobs(t), 'a').needs).toEqual([])
  })
})

describe('parseJobs: dockerfile', () => {
  it('reads dockerfile values in an inline matrix map and in a block key', () => {
    const t = [
      'jobs:',
      '  build:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - { name: legal, dockerfile: docker/legal/Dockerfile, context: docker/legal/ }',
      '          - { name: ui, image: x, dockerfile: gremion-ui/Dockerfile, context: . }',
      '          - name: block',
      '            dockerfile: "services/x/Dockerfile"',
      '    steps:',
      '      - run: docker build -f ${{ matrix.dockerfile }} .',
      '        env:',
      '          DOCKERFILE: ${{ matrix.dockerfile }}',
      '',
    ].join('\n')
    expect(byId(parseJobs(t), 'build').dockerfiles).toEqual(['docker/legal/Dockerfile', 'gremion-ui/Dockerfile', 'services/x/Dockerfile'])
  })

  it('takes no value that holds an expression, and no repeated value', () => {
    const t = ['jobs:', '  b:', '    with:', '      dockerfile: ${{ inputs.f }}', '      other: { dockerfile: a/Dockerfile }', '      again: { dockerfile: ./a/Dockerfile }', ''].join('\n')
    expect(byId(parseJobs(t), 'b').dockerfiles).toEqual(['a/Dockerfile'])
  })
})

describe('parseJobs: scripts', () => {
  const t = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: node scripts/check-one.mjs --static',
    '      - run: |',
    '          set -euo pipefail',
    '          node --test scripts/check-two.test.mjs',
    '          node scripts/check-two.mjs',
    '          bash scripts/run-three.sh',
    '          sh ./scripts/run-four.sh arg',
    '          node --max-old-space-size=3072 scripts/five.mjs --x',
    '          # node scripts/commented-out.mjs',
    '          node scripts/check-one.mjs again',
    '          node -p "require(\'./x/package.json\').version"',
    '          node scripts/$VAR.mjs',
    '          node "$RUNNER_TEMP/gen.mjs"',
    '          node --test --test-reporter=tap scripts/six.test.mjs scripts/seven.mjs',
    '        shell: bash',
    '      - uses: actions/setup-node@abc',
    '        with:',
    '          node-version: 26',
    '',
  ].join('\n')

  it('finds the scripts that node, node --test, bash and sh run, once each, in order', () => {
    expect(byId(parseJobs(t), 'a').scripts).toEqual(['scripts/check-one.mjs', 'scripts/check-two.mjs', 'scripts/run-three.sh', 'scripts/run-four.sh', 'scripts/five.mjs', 'scripts/seven.mjs'])
  })

  it('skips test files', () => {
    const s = byId(parseJobs(t), 'a').scripts
    expect(s.some((x) => /\.test\./.test(x))).toBe(false)
  })

  it('skips a comment, a path with a variable, an inline script and node-version', () => {
    const s = byId(parseJobs(t), 'a').scripts
    expect(s).not.toContain('scripts/commented-out.mjs')
    expect(s.join(' ')).not.toMatch(/\$|RUNNER_TEMP|package\.json|node-version/)
  })

  it('does not take a script from the name of a step', () => {
    const u = ['jobs:', '  a:', '    steps:', '      - name: Run node scripts/not-a-command.mjs', '        run: echo ok', ''].join('\n')
    expect(byId(parseJobs(u), 'a').scripts).toEqual([])
  })
})

describe('parseJobs: pnpm filter and working directory', () => {
  const t = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: pnpm install --frozen-lockfile --filter control-panel...',
    '      - run: pnpm --filter control-panel codemap:check',
    '      - run: pnpm --filter=@gremion/db typecheck',
    '      - run: pnpm --filter ${{ matrix.pkg }} test',
    '      - run: pnpm --filter "@gremion/ports" build',
    '      - run: pnpm run check',
    '        working-directory: apps/control-panel',
    '      - run: node a.js',
    '        working-directory: ./gremion-ui/',
    '      - run: node b.js',
    '        working-directory: ${{ matrix.dir }}',
    '',
  ].join('\n')

  it('finds the package names of pnpm --filter, without the trailing dots', () => {
    expect(byId(parseJobs(t), 'a').filters).toEqual(['control-panel', '@gremion/db', '@gremion/ports'])
  })

  it('finds working-directory values, cleaned, and skips an expression', () => {
    expect(byId(parseJobs(t), 'a').workingDirs).toEqual(['apps/control-panel', 'gremion-ui'])
  })
})

describe('parseJobs: odd input never throws', () => {
  it('accepts CRLF and gives the same result as LF', () => {
    const lf = ['name: x', 'jobs:', '  a:', '    name: "A"', '    needs: [b]', '    steps:', '      - run: node scripts/x.mjs', '  b:', '    needs:', '      - a', ''].join('\n')
    const crlf = lf.replace(/\n/g, '\r\n')
    expect(parseJobs(crlf)).toEqual(parseJobs(lf))
    expect(byId(parseJobs(crlf), 'a')).toMatchObject({ name: 'A', needs: ['b'], scripts: ['scripts/x.mjs'] })
  })

  it('accepts a byte order mark and a document start line', () => {
    const t = '\uFEFF---\njobs:\n  a:\n    name: A\n'
    expect(parseJobs(t).map((j) => j.id)).toEqual(['a'])
  })

  it('a file without a jobs key has no jobs', () => {
    expect(parseJobs('name: x\non: push\npermissions:\n  contents: read\n')).toEqual([])
    expect(parseJobs('')).toEqual([])
  })

  it('a jobs key with nothing under it has no jobs', () => {
    expect(parseJobs('jobs:\n')).toEqual([])
    expect(parseJobs('jobs: {}\n')).toEqual([])
  })

  it('garbage gives no jobs and no throw', () => {
    const garbage = ['\u0000\u0001\u0002', '}{][::::', '   \t\t  ', 'jobs:\n  :\n    :\n', '- - - -\n- : :', 'x'.repeat(100000), `jobs:\n  a:\n    needs: [${'['.repeat(5000)}`]
    for (const g of garbage) expect(() => parseJobs(g)).not.toThrow()
    expect(parseJobs('\u0000\u0001\u0002')).toEqual([])
  })

  it('a value that is not text gives no jobs and no throw', () => {
    for (const v of [null, undefined, 42, {}, [], Buffer.from('jobs:\n  a:\n')]) {
      expect(() => parseJobs(v)).not.toThrow()
      expect(parseJobs(v)).toEqual([])
    }
  })

  it('a long line with many tokens stays fast', () => {
    const line = '      - run: node ' + 'a '.repeat(50000) + 'scripts/x.mjs'
    const t0 = Date.now()
    parseJobs(`jobs:\n  a:\n    steps:\n${line}\n`)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('parseJobs: the real workflow files', () => {
  it('reads the jobs of each workflow file of this repository, and every needs names a job of the same file (shape only: no job name is fixed here, so a CI rename never turns this test red)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.github', 'workflows')
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(1)
    for (const f of files) {
      const jobs = parseJobs(fs.readFileSync(path.join(dir, f), 'utf8'))
      expect(jobs.length, f).toBeGreaterThan(0)
      for (const j of jobs) for (const n of j.needs) expect(jobs.map((x) => x.id), `${f} ${j.id} needs ${n}`).toContain(n)
    }
  })
})

describe('parseJobs: YAML forms that formatters write', () => {
  it('reads a block list of needs that sits at the same indent as the needs key', () => {
    const t = ['jobs:', '  a:', '    runs-on: x', '  b:', '    needs:', '    - a', '    - c', '    runs-on: x', ''].join('\n')
    expect(byId(parseJobs(t), 'b').needs).toEqual(['a', 'c'])
  })

  it('a block list at the key indent ends at the next key, and does not take the steps that follow', () => {
    const t = ['jobs:', '  a:', '    needs:', '    - x', '    steps:', '    - run: node scripts/s.mjs', ''].join('\n')
    const a = byId(parseJobs(t), 'a')
    expect(a.needs).toEqual(['x'])
    expect(a.scripts).toEqual(['scripts/s.mjs'])
  })

  it('reads an inline list of needs that continues on the next lines', () => {
    const t = ['jobs:', '  b:', '    needs: [a,', '      c, # last', '      d]', '    runs-on: x', ''].join('\n')
    expect(byId(parseJobs(t), 'b').needs).toEqual(['a', 'c', 'd'])
  })

  it('a # inside a quoted name is part of the name; a # after the quote is a comment', () => {
    const t = ['jobs:', '  b:', '    name: "Fix #1 issue"', '  c:', "    name: 'Run #2' # a comment", '  d:', '    name: Plain # a comment', ''].join('\n')
    const jobs = parseJobs(t)
    expect(byId(jobs, 'b').name).toBe('Fix #1 issue')
    expect(byId(jobs, 'c').name).toBe('Run #2')
    expect(byId(jobs, 'd').name).toBe('Plain')
  })
})
