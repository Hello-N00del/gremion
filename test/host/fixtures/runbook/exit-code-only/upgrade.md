# Upgrade (fixture)

- Version: 1.0.0
- Status: provisional
- Wall-clock budget: one working day (PRD-PLAT-005)

The TRD-206 pre-migration dump (R18-4), TRD-348 images, TRD-189 blue/green.

## Preconditions

- The new tag exists.

## Steps

1. **Deploy the tag.**

```bash
printf 'TOKEN %s\n' "$GHCR_TOKEN" | /opt/gremion/bin/gremion-deploy "$TAG"
```

## Post-condition

```bash
/opt/gremion/bin/gremion-verify && echo ok
```

## Known gaps

- TRD-348: images come from the registry, not a source build.

## Changelog

- 1.0.0 (2026-09-27): first version.
