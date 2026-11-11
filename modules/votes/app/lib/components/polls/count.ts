// German count label for a poll option: the singular for exactly 1 ("1 Stimme"), the plural for 0
// and for several. The poll page has no $t catalogue of its own and other plural helpers live in
// modules that can be switched off, so the one noun it needs is here.

export const voteCount = (n: number): string => `${n} ${n === 1 ? 'Stimme' : 'Stimmen'}`
