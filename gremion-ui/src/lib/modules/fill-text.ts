// Fills %name% markers in a catalogue text. The legacy `$t(key)` takes no inputs, and a `{name}` in a
// catalogue entry would become a Paraglide input the call cannot supply, so texts with a dynamic part
// carry a %name% marker and the component fills it. An unknown marker stays visible (it is a bug to see,
// not a blank to hide).
export function fillText(text: string, vars: Record<string, string | number>): string {
  return text.replace(/%([a-z]+)%/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}
