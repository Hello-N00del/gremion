// German count labels for the board header: the singular for exactly 1 ("1 Karte"), the plural
// for 0 and for several. The board has no $t catalogue of its own and the other plural helpers live
// in other modules (which can be switched off), so the two nouns the header needs are here.

const label = (n: number, singular: string, plural: string): string => `${n} ${n === 1 ? singular : plural}`

export const cardCount = (n: number): string => label(n, 'Karte', 'Karten')
export const stackCount = (n: number): string => label(n, 'Stack', 'Stacks')
