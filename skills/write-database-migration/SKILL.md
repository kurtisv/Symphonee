---
name: Write a database migration
description: Safe procedure for schema, rights or data migrations on Postgres/Supabase: forward-only, self-verifying, schema and data steps separated, non-blocking indexes, never applied to production without explicit approval.
when: creating or altering tables, columns, indexes, grants, policies, functions, or running a backfill
tags: database, migration, postgres, supabase
---

# Write a database migration

## Use when
- Creating or altering tables, columns, indexes, constraints.
- Changing grants, row-level security policies, or database functions.
- Backfilling or transforming existing data.

## Do not use when
- Read-only queries or analysis -- no migration needed.

## Steps (primary path)
1. Check the real current state first (existing migrations, the live schema if a
   read-only view is available) and the next migration number in the repo.
2. One concern per migration. Keep schema changes and data backfills in separate
   migrations; batch large backfills.
3. Write it forward-only and idempotent where possible (IF NOT EXISTS, guarded DO
   blocks). Production rollback is a new forward migration, documented in the
   same change.
4. Safe defaults: new columns nullable or with a constant default; indexes on
   existing large tables built CONCURRENTLY (outside a transaction); renames by
   expand-contract (add, backfill, switch code, drop later).
5. Rights: revoke from client roles what they must not have; pin search_path on
   security-definer functions and grant execute only to the intended role.
6. Make it self-verifying: end with a check that raises if the intended state is
   not reached, and extend the repo post-deploy verifier so an unapplied or
   regressed migration is reported as a failure, never as a silent success.
7. Add tests that pin the migration text and the verifier behavior, including
   inconsistent or missing reports.

## Safety
- Never apply a migration to production automatically or without the owner
  explicit approval; prepare it and hand over the exact command.
- Never edit a migration that already ran in production; add a new one.
- No NOT NULL without default on an existing table, no blocking index build on a
  large live table, no DROP before every code reference is gone and deployed.
- Never embed secrets or real personal data in migration files.

## Verification
- Applying on a local or test database succeeds, and re-running is harmless.
- The self-check raises when the intended state is broken.
- The verifier reports failure (not success) when the migration is absent.
- The rollback path is written down.
