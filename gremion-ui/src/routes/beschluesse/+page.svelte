<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  // Aggregate Beschlüsse (resolution book) surface. v4 nav links here from the
  // Gremien section. Beschlüsse are passed resolutions from published protocols
  // (the canonical 0007_protocols source); the table renders when rows exist,
  // otherwise the first-class empty state.
  //
  // T6 (#320 contestability): every member sees the 'Anfechten' affordance
  // (POST /api/protocols/resolutions/[resId]/challenges) and the
  // 'Einspruch offen' badge; the disposition controls (stattgeben/abweisen +
  // Anmerkung, PATCH …/challenges/[challengeId]) render ONLY for CouncilAdmin
  // (data.isAdmin, gated server-side in +page.server.ts).
  import type { PageData } from './$types'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { deriveHue } from '$lib/governance/committee-color'
  import { moduleHref } from '$lib/modules/registry'
  import {
    CHALLENGE_GROUNDS_MAX,
    validateChallengeGrounds,
    buildChallengePayload,
  } from '$lib/governance/challenge-form'
  import { invalidateAll } from '$app/navigation'

  let { data }: { data: PageData } = $props()

  // Only point at /votes when a registered module owns it — the empty state is
  // exactly what a fresh instance shows, so a dead link here is the first thing
  // a new deployment sees.
  const votesHref = moduleHref('votes')

  const beschluesse = $derived(data.beschluesse)
  const isAdmin = $derived(data.isAdmin)

  // Admin-only disposition data, grouped per resolution ([] for non-admins).
  const challengesByResolution = $derived.by(() => {
    const m = new Map<string, PageData['challenges'][number][]>()
    for (const c of data.challenges) {
      const list = m.get(c.resolutionId) ?? []
      list.push(c)
      m.set(c.resolutionId, list)
    }
    return m
  })

  // Per-row expandable challenge panel (form + admin disposition list).
  let expandedId = $state<string | null>(null)
  let grounds = $state('')
  let formError = $state<string | null>(null)
  let submitting = $state(false)
  // Disposition state, keyed by challenge id.
  let dispositionNotes = $state<Record<string, string>>({})
  let decidingId = $state<string | null>(null)
  let dispositionError = $state<string | null>(null)

  function togglePanel(id: string) {
    expandedId = expandedId === id ? null : id
    grounds = ''
    formError = null
    dispositionError = null
  }

  async function submitChallenge(resolutionId: string) {
    const v = validateChallengeGrounds(grounds)
    if (!v.ok) {
      formError = v.error
      return
    }
    const req = buildChallengePayload(resolutionId, grounds)
    submitting = true
    formError = null
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        formError = body?.message ?? 'Einspruch konnte nicht eingereicht werden.'
        return
      }
      grounds = ''
      expandedId = null
      await invalidateAll()
    } catch {
      formError = 'Einspruch konnte nicht eingereicht werden.'
    } finally {
      submitting = false
    }
  }

  async function decideChallenge(
    resolutionId: string,
    challengeId: string,
    status: 'upheld' | 'dismissed',
  ) {
    const note = (dispositionNotes[challengeId] ?? '').trim()
    decidingId = challengeId
    dispositionError = null
    try {
      const res = await fetch(
        `/api/protocols/resolutions/${encodeURIComponent(resolutionId)}/challenges/${encodeURIComponent(challengeId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status, decision_note: note.length > 0 ? note : null }),
        },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        dispositionError = body?.message ?? 'Entscheidung konnte nicht gespeichert werden.'
        return
      }
      await invalidateAll()
    } catch {
      dispositionError = 'Entscheidung konnte nicht gespeichert werden.'
    } finally {
      decidingId = null
    }
  }

  const CHALLENGE_STATUS_LABELS: Record<string, string> = {
    open: 'offen',
    upheld: 'stattgegeben',
    dismissed: 'abgewiesen',
    withdrawn: 'zurückgezogen',
  }

  function fmtDate(iso: string): string {
    // iso is YYYY-MM-DD (already date-only from the DB).
    const [y, m, d] = iso.split('-')
    return `${d}.${m}.${y}`
  }

  // Beschluss-Nr: prefer the published global_nr (B-YYYY-NNN); fall back to a
  // synthesized number from the meeting year + per-protocol sequence.
  function beschlussNr(b: PageData['beschluesse'][number]): string {
    if (b.globalNr) return b.globalNr
    const year = b.meetingDate.slice(0, 4)
    return `B-${year}-${String(b.sequenceNr).padStart(3, '0')}`
  }

  function unanimous(b: PageData['beschluesse'][number]): boolean {
    // Acclamation rows carry NO tally (null, not 0) — a null tally can never
    // read as 'einstimmig'; those rows render the 'per Akklamation' pill instead.
    if (b.votesYes === null || b.votesNo === null || b.votesAbstain === null) return false
    return b.votesNo === 0 && b.votesAbstain === 0 && b.votesYes > 0
  }
</script>

<PageTitle title="Beschlüsse" />

<div class="page">
  <header class="page-head">
    <div class="eyebrow">Beschlussbuch</div>
    <h1 class="display">Beschlüsse</h1>
    <p class="page-sub">
      Verbindliche Beschlüsse aller Gremien — volltextsuchbar, mit Verweis aufs zugehörige Protokoll.
    </p>
  </header>

  {#if data.beschluesseUnavailable}
    <!-- Degraded load (#439, R28 review): the register query failed. Say so —
         the first-class empty state below would claim there are no Beschlüsse. -->
    <div class="empty-state" role="alert">
      <div class="glyph"><Icon name="clock" size={22} /></div>
      <div class="ttl">Beschlüsse konnten nicht geladen werden</div>
      <div class="sub">Bitte laden Sie die Seite später erneut.</div>
    </div>
  {:else if beschluesse.length === 0}
    <div class="empty-state">
      <div class="glyph"><Icon name="check" size={22} /></div>
      <div class="ttl">Noch keine Beschlüsse</div>
      <div class="sub">
        Angenommene Anträge und gefasste Beschlüsse werden hier als durchsuchbares
        Beschlussbuch geführt.{#if votesHref}
          Laufende Abstimmungen sehen Sie unter <a href={votesHref}>Abstimmungen</a>.{/if}
      </div>
    </div>
  {:else}
    <div class="card tbl">
      <div class="tbl-row tbl-head">
        <div>Beschluss-Nr.</div>
        <div>Gegenstand</div>
        <div>Gremium · Datum</div>
        <div>Mehrheit</div>
        <div>Einspruch</div>
      </div>
      {#each beschluesse as b (b.id)}
        {@const hue = deriveHue(b.committeeId)}
        <div class="tbl-row">
          <div class="mono td-nr">{beschlussNr(b)}</div>
          <div class="td-trunc">
            <div class="td-primary td-trunc">{b.text}</div>
            <div class="td-muted td-trunc">{b.protocolTitle}</div>
          </div>
          <div>
            <span class="com-mono" style="--c-hue: {hue};">
              <span class="bar"></span>{b.committeeName}
            </span>
            <div class="mono td-muted td-date">{fmtDate(b.meetingDate)}</div>
          </div>
          <div>
            {#if b.adoptionMode === 'acclamation'}
              <!-- Acclamation Beschluss: outcome declared by the chair, no tally
                   to show — never 'einstimmig', never a ja:nein:enthaltung line. -->
              <span class="pill">per Akklamation</span>
            {:else if unanimous(b)}
              <span class="pill pill-success">einstimmig</span>
            {:else}
              <span class="mono td-muted">{b.votesYes}:{b.votesNo}:{b.votesAbstain}</span>
            {/if}
          </div>
          <div class="td-challenge">
            {#if b.openChallengeCount > 0}
              <!-- Pill-icon contract (§16 finding 2): warn tone carries its
                   clock glyph so the badge stays tellable in cb-by mode. -->
              <span class="pill pill-warn">
                <Icon name="clock" size={11} />
                {b.openChallengeCount === 1
                  ? 'Einspruch offen'
                  : `${b.openChallengeCount} Einsprüche offen`}
              </span>
            {/if}
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              aria-expanded={expandedId === b.id}
              onclick={() => togglePanel(b.id)}
            >
              Anfechten
            </button>
          </div>
        </div>
        {#if expandedId === b.id}
          <div class="tbl-detail">
            <!-- Member affordance: every authenticated member may file. -->
            <div class="challenge-form">
              <div class="detail-ttl">Beschluss anfechten</div>
              <p class="detail-sub">
                Der Einspruch wird im Beschlussregister vermerkt und vom zuständigen
                Gremium entschieden. Bitte begründen Sie Ihren Einspruch.
              </p>
              <textarea
                class="grounds-input mono"
                rows="4"
                maxlength={CHALLENGE_GROUNDS_MAX}
                placeholder="Begründung des Einspruchs …"
                aria-label="Begründung"
                bind:value={grounds}
                disabled={submitting}
              ></textarea>
              <div class="form-foot">
                <span class="mono td-muted">Pflichtfeld · höchstens {CHALLENGE_GROUNDS_MAX} Zeichen</span>
                <div class="form-actions">
                  <button type="button" class="btn btn-sm" onclick={() => togglePanel(b.id)}>
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    disabled={submitting}
                    onclick={() => submitChallenge(b.id)}
                  >
                    {submitting ? 'Wird eingereicht …' : 'Einspruch einreichen'}
                  </button>
                </div>
              </div>
              {#if formError}
                <p class="form-error" role="alert">{formError}</p>
              {/if}
            </div>

            {#if isAdmin}
              <!-- CouncilAdmin disposition controls — same gate as the page's
                   surroundings (votes/+page.server.ts:129); the data itself is
                   only loaded for admins in +page.server.ts. -->
              {@const rowChallenges = challengesByResolution.get(b.id) ?? []}
              <div class="disposition">
                <div class="detail-ttl">Einsprüche entscheiden</div>
                {#if data.challengesUnavailable}
                  <p class="form-error" role="alert">Einsprüche konnten nicht geladen werden.</p>
                {:else if rowChallenges.length === 0}
                  <p class="detail-sub">Keine Einsprüche zu diesem Beschluss.</p>
                {:else}
                  {#each rowChallenges as c (c.id)}
                    <div class="challenge-item">
                      <div class="challenge-meta mono td-muted">
                        <span>{c.raisedBy}</span>
                        <span>·</span>
                        <span>Status: {CHALLENGE_STATUS_LABELS[c.status] ?? c.status}</span>
                        {#if c.resolvedBy}
                          <span>·</span>
                          <span>entschieden von {c.resolvedBy}</span>
                        {/if}
                      </div>
                      <div class="challenge-grounds">{c.grounds}</div>
                      {#if c.status === 'open'}
                        <div class="disposition-controls">
                          <input
                            type="text"
                            class="note-input mono"
                            placeholder="Anmerkung zur Entscheidung (optional)"
                            aria-label="Anmerkung zur Entscheidung"
                            bind:value={dispositionNotes[c.id]}
                            disabled={decidingId === c.id}
                          />
                          <button
                            type="button"
                            class="btn btn-sm"
                            disabled={decidingId === c.id}
                            onclick={() => decideChallenge(b.id, c.id, 'upheld')}
                          >
                            Stattgeben
                          </button>
                          <button
                            type="button"
                            class="btn btn-sm"
                            disabled={decidingId === c.id}
                            onclick={() => decideChallenge(b.id, c.id, 'dismissed')}
                          >
                            Abweisen
                          </button>
                        </div>
                      {/if}
                    </div>
                  {/each}
                  {#if dispositionError}
                    <p class="form-error" role="alert">{dispositionError}</p>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>

    <p class="tbl-foot mono">{beschluesse.length} Beschlüsse · Format ja:nein:enthaltung</p>
  {/if}
</div>

<style>
  .page {
    width: 100%;
    max-width: 1180px;
  }
  .page-head {
    margin-bottom: 18px;
  }
  .page-head h1 {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-top: 4px;
  }
  .page-sub {
    color: var(--ink-muted);
    font-size: 13.5px;
    margin-top: 6px;
  }
  .empty-state a {
    color: var(--accent-ink);
    text-decoration: none;
  }
  .empty-state a:hover {
    text-decoration: underline;
  }

  .tbl {
    overflow: hidden;
  }
  .tbl-row {
    display: grid;
    grid-template-columns: 130px 1fr 200px 100px 150px;
    gap: 12px;
    align-items: center;
    padding: 11px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--ink);
  }
  .tbl-row:last-child {
    border-bottom: none;
  }
  .tbl-head {
    background: var(--surface-2);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
  }
  .td-primary {
    font-weight: 500;
  }
  .td-muted {
    color: var(--ink-muted);
    font-size: 12px;
  }
  .td-trunc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .td-nr {
    font-size: 11.5px;
    font-weight: 500;
  }
  .td-date {
    margin-top: 2px;
  }
  .td-challenge {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .td-challenge .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  /* Expanded challenge panel (member form + admin disposition list). */
  .tbl-detail {
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    padding: 14px 16px;
    display: grid;
    gap: 16px;
  }
  .tbl-detail:last-child {
    border-bottom: none;
  }
  .detail-ttl {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
  }
  .detail-sub {
    color: var(--ink-muted);
    font-size: 12px;
    margin-top: 2px;
  }
  .challenge-form {
    display: grid;
    gap: 8px;
    max-width: 640px;
  }
  .grounds-input,
  .note-input {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--paper);
    color: var(--ink);
    font-size: 12.5px;
    padding: 8px 10px;
    resize: vertical;
  }
  .form-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .form-actions {
    display: flex;
    gap: 8px;
  }
  .form-error {
    color: var(--rust-ink, #b23a2f);
    font-size: 12px;
  }

  .disposition {
    display: grid;
    gap: 10px;
    max-width: 640px;
  }
  .challenge-item {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--paper);
    padding: 10px 12px;
    display: grid;
    gap: 6px;
  }
  .challenge-meta {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 11px;
  }
  .challenge-grounds {
    font-size: 12.5px;
    white-space: pre-wrap;
  }
  .disposition-controls {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .disposition-controls .note-input {
    flex: 1 1 220px;
    width: auto;
  }

  /* Committee monogram chip (com-mono) — not in app.css; ported from the
     bundle. A coloured bar + the committee name, hue from committee-color.ts. */
  .com-mono {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .com-mono .bar {
    width: 3px;
    height: 12px;
    border-radius: 2px;
    background: oklch(55% 0.13 var(--c-hue, 252));
    flex-shrink: 0;
  }
  :global(.dark) .com-mono .bar {
    background: oklch(72% 0.14 var(--c-hue, 252));
  }

  .tbl-foot {
    margin-top: 10px;
    font-size: 11px;
    color: var(--ink-faint);
  }
</style>
