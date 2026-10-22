<script lang="ts">
  // PRD-ELE-002 / TRD-030: the permanent scope notice of the optional elections
  // module. Facts and wording come from modules/elections/src/notice/notice.ts;
  // modules/elections/test/notice-keys.test.ts pins the catalogue text to it.
  // Nothing to close and no role branch: member and admin read the same text.
  import { t } from '$lib/i18n'

  // The Du/Sie switch of the instance (UX-013); Du is the default form.
  let { address = 'du' }: { address?: 'du' | 'sie' } = $props()
</script>

<aside class="elections-notice" aria-label={$t('elections.notice.title')} data-testid="elections-notice">
  <h2 class="elections-notice__title">{$t('elections.notice.title')}</h2>
  <p>{$t('elections.notice.scope')}</p>
  <p>{$t(address === 'sie' ? 'elections.notice.followUpSie' : 'elections.notice.followUpDu')}</p>
</aside>

<style>
  .elections-notice {
    border: 1px solid currentColor;
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
    margin-block-end: 1rem;
  }
  .elections-notice__title {
    font-weight: 600;
    margin-block-end: 0.25rem;
  }
</style>
