-- TASK-044 (brief Q6, section 9): the isolation evidence a SCRATCH proof stack
-- seeds so `gremion-tenant create --enable calendar,votes` passes through the
-- REAL level-1 gate (no allow gate exists in src/). Applied by
-- customer-provision-proof.sh ONLY on a tNNN-<sha8> pooled stack; the container
-- gate accepts the `scratch-fixture:` prefix only on that stack's own platform
-- database host (tenant-provision-scratch.ts), and refuses it everywhere else
-- with FIXTURE_EVIDENCE.
--   psql -v tip=<40-hex release tip> -v modules='calendar,votes' -f scratch-fixture.sql
-- Idempotent: a module that already holds a passing fixture row for the tip gets none.
INSERT INTO plt.isolation_test_result (module_id, test_kind, passed, run_at, evidence_ref, release_tip_sha)
SELECT m.module_id, 'cross_customer', true, now(), 'scratch-fixture: customer-provision-proof', :'tip'
  FROM plt.module m
 WHERE m.module_key = ANY (string_to_array(:'modules', ','))
   AND NOT EXISTS (
     SELECT 1 FROM plt.isolation_test_result r
      WHERE r.module_id = m.module_id AND r.test_kind = 'cross_customer' AND r.passed
        AND r.release_tip_sha = :'tip' AND r.evidence_ref LIKE 'scratch-fixture:%'
        AND r.run_at = (SELECT max(run_at) FROM plt.isolation_test_result x WHERE x.module_id = m.module_id AND x.test_kind = 'cross_customer'));
