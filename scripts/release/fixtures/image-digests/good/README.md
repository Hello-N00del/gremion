# check-image-digests fixture tree (TASK-048)

A miniature repository the guard's suite copies into a scratch git repo and
scans. It is GREEN as committed; each RED case in
`scripts/release/check-image-digests.test.mjs` edits one file of a copy.

Files under `decoys/` sit where a recursive or un-anchored scan would find
them (the paths mirror real out-of-scope trees); the suite moves them into
place, so a guard that stopped anchoring its pathspecs fails on their tag-only
images. Every digest here is synthetic.
