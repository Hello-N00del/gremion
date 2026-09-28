// services/calendar/src/store/calendar-color.ts
//
// Calendar dual-tone colour computation. Ported verbatim (pure logic, no DB
// deps) from gremion-ui/src/lib/server/calendar/calendar-color.ts.
//
// Every event payload carries a { primary, secondary } pair used to render the
// left/right halves of the event chip. Scenarios:
//   - Single committee  → primary = committee colour, secondary = event type colour
//   - Multi-committee   → primary = sharedEventColor, secondary = event type colour
//   - No committee      → solid event-type colour (primary == secondary)

export interface EventColourInput {
  isMultiCommittee: boolean
  hasCommittee: boolean
  committeeColor: string | null
  eventTypeColor: string | null
  sharedEventColor: string
}

export interface EventColour {
  primary: string
  secondary: string
}

export const FALLBACK_COLOR = '#6366f1'
export const DEFAULT_SHARED_EVENT_COLOR = '#94a3b8'

export function computeEventColour(input: EventColourInput): EventColour {
  const secondary = input.eventTypeColor ?? FALLBACK_COLOR

  if (!input.hasCommittee) {
    return { primary: secondary, secondary }
  }

  if (input.isMultiCommittee) {
    return { primary: input.sharedEventColor, secondary }
  }

  return { primary: input.committeeColor ?? FALLBACK_COLOR, secondary }
}
