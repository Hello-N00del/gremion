<script lang="ts">
  // OrganisationTree — public org structure rendered as a two-level tree
  // (PR 5 T5.1.4). Replaces the bundle's static "Was wir tun" three-column
  // section with the portal's real org_units hierarchy. Read-only; consumes
  // the GDPR-safe PublicCommittee projection and the app.css token system.

  import type { PublicCommittee } from '@gremion/db/public-types';

  let { committees = [] }: { committees?: PublicCommittee[] } = $props();

  interface TreeNode extends PublicCommittee {
    children: PublicCommittee[];
  }

  // Build a parent → children tree. Anything without a (resolvable) parent is
  // treated as a root so nothing is silently dropped.
  const roots = $derived.by<TreeNode[]>(() => {
    const byId = new Map(committees.map((c) => [c.id, c]));
    const childrenOf = new Map<string, PublicCommittee[]>();
    const rootList: PublicCommittee[] = [];

    for (const c of committees) {
      if (c.parent_id && byId.has(c.parent_id)) {
        const arr = childrenOf.get(c.parent_id) ?? [];
        arr.push(c);
        childrenOf.set(c.parent_id, arr);
      } else {
        rootList.push(c);
      }
    }

    return rootList.map((r) => ({ ...r, children: childrenOf.get(r.id) ?? [] }));
  });
</script>

<section id="organisation" class="border-b border-border bg-surface">
  <div class="mx-auto max-w-7xl px-5 py-14 lg:py-[70px]">
    <div class="mb-12 grid items-end gap-10 lg:grid-cols-[1fr_1.5fr]">
      <div>
        <p class="mb-1 font-mono text-[11px] tracking-widest text-ink-muted uppercase">
          Wer wir sind
        </p>
        <h2 class="font-display text-4xl font-medium leading-tight tracking-tight text-ink">
          Die Struktur, transparent.
        </h2>
      </div>
      <p class="max-w-xl text-[16px] text-ink-2">
        Gremien, Referate und Fachschaften der gewählten Vertretung — jedes mit
        eigenem Aufgabenbereich, alle dem Plenum gegenüber rechenschaftspflichtig.
      </p>
    </div>

    {#if roots.length === 0}
      <p class="text-ink-muted">Die Organisationsstruktur wird derzeit aktualisiert.</p>
    {:else}
      <ul class="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {#each roots as node, i (node.id)}
          <li class="border-t border-ink-2 pt-5">
            <span class="font-display text-2xl font-medium italic text-ember">
              {String(i + 1).padStart(2, '0')} ·
            </span>
            <h3 class="mt-2 font-display text-[20px] font-medium tracking-tight text-ink">
              {node.name}
            </h3>
            {#if node.description}
              <p class="mt-2 text-[14.5px] leading-relaxed text-ink-2">{node.description}</p>
            {/if}

            {#if node.children.length > 0}
              <ul class="mt-3 flex flex-wrap gap-1.5">
                {#each node.children as child (child.id)}
                  <li
                    class="rounded-full bg-surface-2 px-2.5 py-1 font-mono text-[11px]
                           tracking-wide text-ink-2"
                  >
                    {child.name}
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
