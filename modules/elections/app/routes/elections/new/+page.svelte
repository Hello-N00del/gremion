<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { resolveBrand } from '$lib/brand'
  // Election-wizard module CSS (moved out of app.css — design-review 2026-07
  // T3); this page is the sole .wiz-* consumer. Route-level import → code-split.
  import './wizard.css'

  let { data }: { data: PageData } = $props()

  // The product name must come from the tenant brand, never inlined
  // (brand.guard.test.ts) — used in the Helios trust rail's e2e line.
  const brand = $derived(resolveBrand(page.data.brand))

  interface Question {
    question: string
    shortName: string
    answers: string[]
    min: number
    max: number
  }

  interface MemberPreview {
    email: string
    name: string
    keycloakId: string
  }

  // ── Form state ────────────────────────────────────────────────────────────
  let step = $state<1 | 2 | 3 | 4 | 5>(1)
  let submitting = $state(false)
  let errorMsg = $state('')

  // Step 1: Basics
  let title = $state('')
  let shortName = $state('')
  let description = $state('')
  let committeeId = $state('')

  // Step 2: Questions
  let questions = $state<Question[]>([
    { question: '', shortName: 'q1', answers: ['', ''], min: 1, max: 1 },
  ])

  // Step 3: Voters
  let members = $state<MemberPreview[]>([])
  let removedEmails = $state<Set<string>>(new Set())
  let loadingMembers = $state(false)
  let extraVoters = $state<MemberPreview[]>([])
  let voterSearch = $state('')
  let voterSearchResults = $state<MemberPreview[]>([])
  let loadingSearch = $state(false)

  // Step 4: Schedule
  let votingStartsAt = $state('')
  let votingEndsAt = $state('')
  let createCalendarEvents = $state(true)
  let freeze = $state(false)

  // ── Derived ─────────────────────────────────────────────────────────────
  const selectedCommittee = $derived(
    data.committees.find((c) => c.id === committeeId) ?? null,
  )

  const step1Valid = $derived(
    title.trim().length > 0 &&
      shortName.trim().length > 0 &&
      /^[a-z0-9-]+$/.test(shortName) &&
      committeeId.length > 0,
  )

  const step2Valid = $derived(
    questions.length > 0 &&
      questions.every(
        (q) =>
          q.question.trim().length > 0 &&
          q.answers.filter((a) => a.trim().length > 0).length >= 2 &&
          q.min >= 0 &&
          q.max >= q.min &&
          q.max <= q.answers.length,
      ),
  )

  const step4Valid = $derived(
    votingStartsAt.length > 0 &&
      votingEndsAt.length > 0 &&
      new Date(votingStartsAt) < new Date(votingEndsAt),
  )

  const voterCount = $derived(
    members.filter((m) => !removedEmails.has(m.email)).length + extraVoters.length,
  )

  // ── Actions ─────────────────────────────────────────────────────────────
  async function goToStep3() {
    if (!selectedCommittee) return
    step = 3
    loadingMembers = true
    errorMsg = ''
    try {
      const res = await fetch(`/api/governance/committees/${selectedCommittee.id}/members`)
      if (!res.ok) {
        errorMsg = 'Mitglieder konnten nicht geladen werden.'
        members = []
      } else {
        const body = await res.json()
        // The governance members endpoint returns DB rows; we need email+name.
        // Fall back to keycloakId display if email missing.
        members = (body.data ?? []).map((m: { user_keycloak_id: string; email?: string; name?: string }) => ({
          email: m.email ?? m.user_keycloak_id,
          name: m.name ?? m.user_keycloak_id,
          keycloakId: m.user_keycloak_id,
        }))
      }
    } catch {
      errorMsg = 'Verbindungsfehler beim Laden der Mitglieder.'
      members = []
    } finally {
      loadingMembers = false
    }
  }

  function addQuestion() {
    questions = [
      ...questions,
      {
        question: '',
        shortName: `q${questions.length + 1}`,
        answers: ['', ''],
        min: 1,
        max: 1,
      },
    ]
  }

  function removeQuestion(i: number) {
    questions = questions.filter((_, idx) => idx !== i)
  }

  function addAnswer(qIdx: number) {
    questions[qIdx].answers = [...questions[qIdx].answers, '']
  }

  function removeAnswer(qIdx: number, aIdx: number) {
    if (questions[qIdx].answers.length <= 2) return
    questions[qIdx].answers = questions[qIdx].answers.filter((_, i) => i !== aIdx)
    if (questions[qIdx].max > questions[qIdx].answers.length) {
      questions[qIdx].max = questions[qIdx].answers.length
    }
  }

  function toggleRemoved(email: string) {
    const next = new Set(removedEmails)
    if (next.has(email)) next.delete(email)
    else next.add(email)
    removedEmails = next
  }

  async function searchVoters() {
    if (!voterSearch.trim()) return
    loadingSearch = true
    voterSearchResults = []
    errorMsg = ''
    try {
      const res = await fetch(
        `/api/users?search=${encodeURIComponent(voterSearch.trim())}&slim=true&max=10`,
      )
      if (!res.ok) {
        errorMsg = 'Personensuche fehlgeschlagen. Bitte erneut versuchen.'
        return
      }
      const body = await res.json()
      const alreadyListed = new Set([
        ...members.map((m) => m.keycloakId),
        ...extraVoters.map((v) => v.keycloakId),
      ])
      voterSearchResults = (body.data ?? [])
        .filter((u: { id: string }) => !alreadyListed.has(u.id))
        .map((u: { id: string; email?: string; firstName?: string; lastName?: string; username?: string }) => ({
          keycloakId: u.id,
          email: u.email ?? '',
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.email || u.id,
        }))
    } catch {
      errorMsg = 'Verbindungsfehler bei der Personensuche.'
    } finally {
      loadingSearch = false
    }
  }

  function addExtraVoter(voter: MemberPreview) {
    extraVoters = [...extraVoters, voter]
    voterSearchResults = voterSearchResults.filter((r) => r.keycloakId !== voter.keycloakId)
  }

  function removeExtraVoter(keycloakId: string) {
    extraVoters = extraVoters.filter((v) => v.keycloakId !== keycloakId)
  }

  async function submit() {
    if (!selectedCommittee) return
    submitting = true
    errorMsg = ''

    const payload = {
      title,
      shortName,
      description,
      committeeId: selectedCommittee.id,
      votingStartsAt: new Date(votingStartsAt).toISOString(),
      votingEndsAt: new Date(votingEndsAt).toISOString(),
      questions: questions.map((q) => ({
        question: q.question,
        shortName: q.shortName,
        answers: q.answers.filter((a) => a.trim().length > 0),
        min: q.min,
        max: q.max,
      })),
      removedVoterEmails: Array.from(removedEmails),
      extraVoters: extraVoters.map((v) => ({ email: v.email, name: v.name })),
      createCalendarEvents,
      freeze,
    }

    try {
      const res = await fetch('/api/elections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok || !body.success) {
        errorMsg = body.error ?? `Fehler ${res.status}`
        submitting = false
        return
      }
      await goto(`/elections/${body.data.uuid}`)
    } catch {
      errorMsg = 'Verbindungsfehler. Bitte erneut versuchen.'
      submitting = false
    }
  }

  // Stepper labels (the five-step flow is unchanged; #166 is presentation only).
  const STEPS = ['Grunddaten', 'Fragen', 'Wähler', 'Termin', 'Bestätigen']
</script>

<PageTitle title="Neue Wahl" />

<!-- #166 — restyled from generic shadcn into the shared design-token idiom: a
     real stepper, token field cards, and a persistent Helios trust rail. The
     five-step flow, the POST /api/elections payload, and every step validator
     are unchanged. -->
<div class="wiz">
  <div class="wiz-top">
    <a class="wiz-back" href="/elections">
      <span style="display:inline-flex;transform:rotate(180deg)"><Icon name="arrow-right" size={14} /></span>
      Zurück zu Wahlen
    </a>
    <span class="wiz-kindpill"><Icon name="shield" size={11} /> Helios-Wahl</span>
  </div>

  <div class="wiz-title">Neue Wahl anlegen</div>
  <div class="wiz-sub">
    End-to-end verschlüsselt, anonym und öffentlich verifizierbar. Anlage durch Vorstand / Wahlausschuss.
  </div>

  <!-- Stepper -->
  <div class="wiz-stepper">
    {#each STEPS as lbl, i}
      {@const n = i + 1}
      <div class="wiz-step {step === n ? 'active' : step > n ? 'done' : ''}">
        <span class="num">
          {#if step > n}<Icon name="check" size={14} />{:else}{n}{/if}
        </span>
        <span class="lbl">{lbl}</span>
      </div>
      {#if i < STEPS.length - 1}<span class="wiz-step-line"></span>{/if}
    {/each}
  </div>

  {#if errorMsg}
    <div class="notice-strip" style="background:var(--rust-soft);color:var(--rust-ink);margin-bottom:16px">
      <Icon name="alert-triangle" size={14} /> {errorMsg}
    </div>
  {/if}

  <div class="wiz-grid">
    <div class="wiz-card">
      {#if step === 1}
        <!-- STEP 1: Basics -->
        <h2>Grunddaten</h2>
        <div class="wiz-field">
          <label for="title">Titel der Wahl</label>
          <input id="title" class="wiz-input" bind:value={title} placeholder="z. B. Vorstandswahl SoSe 2026" />
        </div>
        <div class="wiz-field">
          <label for="shortName">Kurzname (URL-tauglich)</label>
          <input id="shortName" class="wiz-input mono" bind:value={shortName} placeholder="vorstandswahl-sose-2026" pattern="[a-z0-9-]+" />
          <span class="hint">Nur Kleinbuchstaben, Ziffern, Bindestriche.</span>
        </div>
        <div class="wiz-field">
          <label for="description">Beschreibung</label>
          <textarea id="description" class="wiz-textarea" bind:value={description} placeholder="Worüber wird abgestimmt?"></textarea>
        </div>
        <div class="wiz-field" style="margin-bottom:0">
          <label for="committee">Gremium</label>
          <select id="committee" class="wiz-select" bind:value={committeeId}>
            <option value="">Bitte wählen …</option>
            {#each data.committees as c}
              <option value={c.id}>{c.name}</option>
            {/each}
          </select>
          <span class="hint">Die Wähler:innen werden aus dem Gremium übernommen (Schritt 3).</span>
        </div>
      {:else if step === 2}
        <!-- STEP 2: Questions -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
          <h2 style="margin:0">Fragen &amp; Antwortoptionen</h2>
          <button type="button" class="btn btn-sm" onclick={addQuestion}><Icon name="plus" size={13} /> Frage</button>
        </div>
        {#each questions as q, qIdx (qIdx)}
          <div class="wiz-q">
            <div class="wiz-q-head">
              <span class="qn">Frage {qIdx + 1}</span>
              {#if questions.length > 1}
                <button type="button" class="wiz-iconbtn" onclick={() => removeQuestion(qIdx)} aria-label="Frage entfernen"><Icon name="x" size={13} /></button>
              {/if}
            </div>
            <div class="wiz-field">
              <label for="q-{qIdx}">Fragetext</label>
              <input id="q-{qIdx}" class="wiz-input" bind:value={q.question} placeholder="z. B. Wer soll den Vorsitz übernehmen?" />
            </div>
            <span class="wiz-ans-label">Antwortoptionen</span>
            {#each q.answers as _answer, aIdx (aIdx)}
              <div class="wiz-ans-row">
                <span class="dot"></span>
                <input class="wiz-input" bind:value={q.answers[aIdx]} placeholder="Option {aIdx + 1}" />
                {#if q.answers.length > 2}
                  <button type="button" class="wiz-iconbtn" onclick={() => removeAnswer(qIdx, aIdx)} aria-label="Option entfernen"><Icon name="x" size={12} /></button>
                {/if}
              </div>
            {/each}
            <button type="button" class="btn btn-sm btn-ghost" style="margin-top:4px" onclick={() => addAnswer(qIdx)}><Icon name="plus" size={12} /> Option</button>
            <div class="wiz-row2" style="margin-top:14px">
              <div class="wiz-field" style="margin-bottom:0">
                <label for="min-{qIdx}">Min. Kreuze</label>
                <input id="min-{qIdx}" class="wiz-input mono" type="number" min="0" max={q.answers.length} bind:value={q.min} />
              </div>
              <div class="wiz-field" style="margin-bottom:0">
                <label for="max-{qIdx}">Max. Kreuze</label>
                <input id="max-{qIdx}" class="wiz-input mono" type="number" min={q.min} max={q.answers.length} bind:value={q.max} />
              </div>
            </div>
          </div>
        {/each}
      {:else if step === 3}
        <!-- STEP 3: Voters -->
        <h2>
          Wähler:innen{#if selectedCommittee}<span style="font-weight:400;color:var(--ink-muted);font-size:14px"> · aus {selectedCommittee.name}</span>{/if}
        </h2>
        {#if loadingMembers}
          <div style="font-size:12.5px;color:var(--ink-muted)">Lade Mitglieder…</div>
        {:else if members.length === 0}
          <div class="notice-strip" style="margin-bottom:12px">
            <Icon name="info" size={14} /> Keine Mitglieder gefunden. Bitte das Gremium zuerst unter Mitglieder pflegen.
          </div>
        {:else}
          <div style="font-size:12.5px;color:var(--ink-muted);margin-bottom:12px">
            <b style="color:var(--ink)">{voterCount}</b> stimmberechtigt · per Häkchen ausschließen.
          </div>
          <div class="wiz-voterbox">
            {#each members as m (m.keycloakId)}
              <label class="wiz-voter" style="cursor:pointer">
                <input type="checkbox" checked={!removedEmails.has(m.email)} onchange={() => toggleRemoved(m.email)} aria-label="Einschließen: {m.name}" />
                <div style="flex:1;min-width:0">
                  <div class="nm">{m.name}</div>
                  <div class="em">{m.email}</div>
                </div>
              </label>
            {/each}
          </div>
        {/if}

        <!-- Extra voters -->
        <div style="display:flex;gap:8px;margin-top:14px">
          <input
            class="wiz-input"
            style="flex:1"
            placeholder="Weitere Person suchen (Name oder E-Mail) …"
            bind:value={voterSearch}
            onkeydown={(e) => e.key === 'Enter' && searchVoters()}
          />
          <button type="button" class="btn btn-sm" onclick={searchVoters} disabled={loadingSearch}>
            <Icon name="search" size={13} /> {loadingSearch ? '…' : 'Suchen'}
          </button>
        </div>

        {#if voterSearchResults.length > 0}
          <div class="wiz-voterbox" style="margin-top:10px">
            {#each voterSearchResults as r (r.keycloakId)}
              <div class="wiz-voter" style="justify-content:space-between">
                <div style="min-width:0">
                  <div class="nm">{r.name}</div>
                  <div class="em">{r.email}</div>
                </div>
                <button type="button" class="wiz-iconbtn" onclick={() => addExtraVoter(r)} aria-label="Hinzufügen"><Icon name="plus" size={14} /></button>
              </div>
            {/each}
          </div>
        {/if}

        {#if extraVoters.length > 0}
          <div style="font-size:11.5px;color:var(--ink-muted);margin-top:12px;margin-bottom:4px">Zusätzlich hinzugefügt:</div>
          <div class="wiz-voterbox">
            {#each extraVoters as v (v.keycloakId)}
              <div class="wiz-voter" style="justify-content:space-between">
                <div style="min-width:0">
                  <div class="nm">{v.name}</div>
                  <div class="em">{v.email}</div>
                </div>
                <button type="button" class="wiz-iconbtn" onclick={() => removeExtraVoter(v.keycloakId)} aria-label="Entfernen"><Icon name="x" size={13} /></button>
              </div>
            {/each}
          </div>
        {/if}
      {:else if step === 4}
        <!-- STEP 4: Schedule -->
        <h2>Termin &amp; Kalender</h2>
        <div class="wiz-row2">
          <div class="wiz-field">
            <label for="startsAt">Beginn der Stimmabgabe</label>
            <input id="startsAt" class="wiz-input [color-scheme:light] dark:[color-scheme:dark]" type="datetime-local" bind:value={votingStartsAt} />
          </div>
          <div class="wiz-field">
            <label for="endsAt">Ende der Stimmabgabe</label>
            <input id="endsAt" class="wiz-input [color-scheme:light] dark:[color-scheme:dark]" type="datetime-local" bind:value={votingEndsAt} />
          </div>
        </div>
        {#if votingStartsAt && votingEndsAt && new Date(votingStartsAt) >= new Date(votingEndsAt)}
          <div class="notice-strip" style="background:var(--rust-soft);color:var(--rust-ink);margin-bottom:14px">
            <Icon name="info" size={14} /> Das Ende muss nach dem Beginn liegen.
          </div>
        {/if}
        <label class="wiz-voter wiz-checkbox-card">
          <input type="checkbox" bind:checked={createCalendarEvents} />
          <div>
            <div class="nm">Kalendereintrag für das Gremium erstellen</div>
            <div class="em" style="font-family:var(--font-body)">Beginn und Ende werden im Gremiumskalender eingetragen.</div>
          </div>
        </label>
        <label class="wiz-voter wiz-checkbox-card">
          <input type="checkbox" bind:checked={freeze} />
          <div>
            <div class="nm">Sofort einfrieren &amp; starten</div>
            <div class="em" style="font-family:var(--font-body)">Ohne Häkchen bleibt die Wahl ein Entwurf im Helios-Admin.</div>
          </div>
        </label>
      {:else if step === 5}
        <!-- STEP 5: Confirm -->
        <h2>Zusammenfassung</h2>
        <dl style="margin:0">
          <div class="wiz-sum-row"><dt>Titel</dt><dd>{title || '—'}</dd></div>
          <div class="wiz-sum-row"><dt>Kurzname</dt><dd class="mono">{shortName || '—'}</dd></div>
          <div class="wiz-sum-row"><dt>Gremium</dt><dd>{selectedCommittee?.name ?? '—'}</dd></div>
          <div class="wiz-sum-row"><dt>Fragen</dt><dd>{questions.length}</dd></div>
          <div class="wiz-sum-row"><dt>Wähler:innen</dt><dd>{voterCount}</dd></div>
          <div class="wiz-sum-row">
            <dt>Zeitraum</dt>
            <dd>
              {votingStartsAt ? new Date(votingStartsAt).toLocaleString('de-DE') : '—'}
              – {votingEndsAt ? new Date(votingEndsAt).toLocaleString('de-DE') : '—'}
            </dd>
          </div>
          <div class="wiz-sum-row"><dt>Kalendereintrag</dt><dd>{createCalendarEvents ? 'Ja' : 'Nein'}</dd></div>
          <div class="wiz-sum-row"><dt>Sofort starten</dt><dd>{freeze ? 'Ja' : 'Nein'}</dd></div>
        </dl>
        <div class="notice-strip" style="background:var(--accent-soft);color:var(--accent-ink);margin-top:18px;margin-bottom:0">
          <Icon name="shield" size={15} />
          <span>Nach dem Anlegen erzeugt Helios die Wahl-Schlüssel. Der Wahlausschuss (Trustees) zeichnet sie frei, bevor die Stimmabgabe öffnet.</span>
        </div>
      {/if}
    </div>

    <!-- Persistent Helios trust rail — the e2e framing carried from the detail panel. -->
    <aside class="wiz-rail">
      <div class="wiz-rail-h"><Icon name="shield" size={12} /> Helios · E2E</div>
      <div class="wiz-rail-row">
        <span class="ic"><Icon name="key" size={15} /></span>
        <div><div class="t">Verschlüsselung</div><div class="d">ElGamal · 4096 bit</div></div>
      </div>
      <div class="wiz-rail-row">
        <span class="ic"><Icon name="users" size={15} /></span>
        <div><div class="t">Trustees</div><div class="d">Wahlausschuss zeichnet</div></div>
      </div>
      <div class="wiz-rail-row">
        <span class="ic"><Icon name="lock" size={15} /></span>
        <div><div class="t">Anonym</div><div class="d">RE-MIX · ZK-Proof</div></div>
      </div>
      <div class="wiz-rail-foot">
        Stimmzettel werden im Browser verschlüsselt, bevor sie den Server erreichen. {brand.product} sieht keine Einzelstimme.
      </div>
    </aside>
  </div>

  <!-- Footer nav (per-step routing unchanged: step 2→3 loads members via goToStep3). -->
  <div class="wiz-foot">
    {#if step > 1}
      <button type="button" class="btn" onclick={() => (step = (step - 1) as 1 | 2 | 3 | 4 | 5)}>Zurück</button>
    {:else}
      <a class="btn btn-ghost" href="/elections">Abbrechen</a>
    {/if}

    {#if step === 1}
      <button type="button" class="btn btn-primary" onclick={() => (step = 2)} disabled={!step1Valid}>Weiter <Icon name="arrow-right" size={14} /></button>
    {:else if step === 2}
      <button type="button" class="btn btn-primary" onclick={goToStep3} disabled={!step2Valid}>Weiter <Icon name="arrow-right" size={14} /></button>
    {:else if step === 3}
      <button type="button" class="btn btn-primary" onclick={() => { errorMsg = ''; step = 4 }} disabled={loadingMembers || voterCount < 1}>Weiter <Icon name="arrow-right" size={14} /></button>
    {:else if step === 4}
      <button type="button" class="btn btn-primary" onclick={() => { errorMsg = ''; step = 5 }} disabled={!step4Valid}>Weiter <Icon name="arrow-right" size={14} /></button>
    {:else}
      <button type="button" class="btn btn-primary" onclick={submit} disabled={submitting}>
        <Icon name="shield" size={14} /> {submitting ? 'Wird angelegt…' : 'Wahl anlegen'}
      </button>
    {/if}
  </div>
</div>
