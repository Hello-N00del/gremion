// Mirrors the jscrypto load order of Helios' own booth (`/app/heliosbooth/vote.html`
// in the helios container). `prng4.js`/`rng.js` are NOT shipped by Helios — it uses
// `sjcl.js` + `random.js` for entropy instead — so requesting them always 404s.
const JSCRYPTO_SCRIPTS = [
  'class.js',
  'bigint.dummy.js',
  'jsbn.js',
  'jsbn2.js',
  'sjcl.js',
  'bigint.js',
  'random.js',
  'elgamal.js',
  'sha1.js',
  'sha2.js',
]

let _loaded = false

export async function loadJsCrypto(heliosBase: string): Promise<void> {
  if (_loaded) return
  // Helios serves the booth assets under /booth, not /static/heliosbooth.
  const base = `${heliosBase}/booth/js/jscrypto`
  for (const name of JSCRYPTO_SCRIPTS) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = `${base}/${name}`
      s.dataset.jscrypto = '1'
      s.onload = () => resolve()
      s.onerror = () => reject(new Error(`Failed to load ${base}/${name}`))
      document.head.appendChild(s)
    })
  }
  _loaded = true
}

export interface QuestionShape {
  answers: string[]
  min: number
  max: number
}

export function buildAnswerVector(
  question: QuestionShape,
  selectedIndices: number[],
): number[] {
  return question.answers.map((_, i) => (selectedIndices.includes(i) ? 1 : 0))
}

function getElGamal(): { encrypt: (plaintext: number, pk: unknown) => unknown; prove_0_or_1: (c: unknown, pk: unknown) => unknown } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any
  if (!w.ElGamal) throw new Error('ElGamal not loaded — call loadJsCrypto first')
  return w.ElGamal
}

export interface EncryptedAnswer {
  choices: unknown[]
  individual_proofs: unknown[]
  overall_proof: unknown
}

export function encryptAnswer(
  question: QuestionShape,
  selectedIndices: number[],
  publicKey: unknown,
): EncryptedAnswer {
  const elgamal = getElGamal()
  const vector = buildAnswerVector(question, selectedIndices)
  const ciphertexts = vector.map((bit) => elgamal.encrypt(bit, publicKey))
  const proofs = ciphertexts.map((c) => elgamal.prove_0_or_1(c, publicKey))
  return {
    choices: ciphertexts,
    individual_proofs: proofs,
    overall_proof: (window as unknown as Record<string, unknown>)['ElGamal_prove_selection'] ?? null,
  }
}
