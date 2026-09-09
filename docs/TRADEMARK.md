# Trademark and naming

## The project's name

The name of this project is **Gremion**. It is the name used for the software,
the repositories, the container images (`ghcr.io/hello-n00del/gremion-*`), the
npm scope (`@gremion/*`) and every outward communication.

## Filing status

**A trademark application is pending preparation, not granted.** The project name
has been adopted and is in use; a filing with the DPMA (Deutsches Patent- und
Markenamt) will follow a lawyer's opinion, which is outstanding at the time of
writing. The known point that opinion has to resolve is an earlier German
application for the similar mark **"Gremio"** in classes 9, 35 and 42.

Until that opinion is in, treat the name as *adopted and used*, not as
*registered*. Nothing in this repository asserts a registered mark, and no
`®` is used anywhere.

## Why "Civitas" is not the name

An earlier internal working name for this project was *Civitas*. It is not the
project's name and is not used outwardly, for two independent reasons:

- **CIVITAS** is a live registered trade mark in class 42, held by CIVITAS
  INTERNATIONAL Management Consultants GmbH.
- *CIVITAS/CORE* is the platform brand of Civitas Connect e.V., which puts the
  name directly in this project's own field.

The alias is named in two places — on this page, and in
[`about-gremion.md`](./about-gremion.md) — so that a reader who encounters it in
the commit history knows what it refers to. What still carries the old name in
this tree is the header comment text of four applied migrations (`008`, `042`,
`043`, `048`); it is inventoried as naming debt in
[`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) and is not renamed in 0.1.0 because
migration files are hash-pinned and forward-only — editing one after it has been
applied makes every existing database fail integrity verification on boot.

No Docker volume, network, or database name carries it: the volumes are
`gremion_pg_data`, `gremion_mailpit_data`, `gremion_config_data`,
`gremion_tenant_config_data`, `gremion_traefik_logs` and
`gremion_vector_processed_logs`, the network is `gremion_net`, and the databases
are `keycloak`, `gremion` and `control`.

## Using the name

The **software** is AGPL-3.0-only and you may run, modify and redistribute it on
those terms; see [`../LICENSE`](../LICENSE). A licence to the code is not a
licence to the name. You may state truthfully that your deployment is built on
Gremion, or is a fork of it. Please do not name a modified distribution "Gremion"
in a way that suggests it is this project, or use the name in a way that implies
endorsement.

If you are unsure whether a use is fine, ask first — the contacts in
[`../SECURITY.md`](../SECURITY.md) reach the maintainers.
