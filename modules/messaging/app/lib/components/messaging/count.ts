// German count labels for the messages page: the singular for exactly 1 ("1 Raum", "1 Nachricht"),
// the plural for 0 and for several. The messages module has no $t catalogue of its own and the other
// plural helpers live in other modules (which can be switched off), so the two nouns it needs are here.

const label = (n: number, singular: string, plural: string): string => `${n} ${n === 1 ? singular : plural}`

export const roomCount = (n: number): string => label(n, 'Raum', 'Räume')
export const messageCount = (n: number): string => label(n, 'Nachricht', 'Nachrichten')
export const unreadMessageCount = (n: number): string => label(n, 'ungelesene Nachricht', 'ungelesene Nachrichten')
