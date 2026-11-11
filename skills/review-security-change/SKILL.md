---
name: Review a security-sensitive change
description: Checklist and procedure for changes touching authentication, sessions, user data access, secrets, API inputs, database rights or payments, and for a full security audit: authorization (account A vs B), secrets including git history, input validation, database roles, safe non-destructive testing.
when: adding or changing auth, endpoints, data access, secrets, database policies or payment logic, or auditing an app for vulnerabilities
tags: security, review, api, database
---

# Review a security-sensitive change

## Use when
- Adding or changing authentication, sessions, password reset, OAuth sign-in.
- Creating or modifying an API endpoint, especially one using a privileged
  database key or calling a paid third-party API.
- Touching row-level security, table/column grants, database functions, storage.
- Handling secrets, tokens, personal data, location, payments or entitlements.
- A requested security audit.

## Do not use when
- Pure UI/styling change with no data, auth or input path.

## Steps (primary path)
1. Map the surface: endpoints, who can call them (anonymous, any user, admin,
   cron), which identity they trust, which key they use to reach data.
2. Authorization with two synthetic accounts A and B: can A read or change B data
   by changing an id, an email or a parameter? Is every lookup scoped to the
   authenticated identity rather than to a client-supplied value?
3. Authentication: password reset and account linking must prove control of the
   identity (verified email, recent proof, a method that cannot come from another
   channel). Never link accounts on an unverified email. Check that sessions can
   be revoked after a password change.
4. Secrets: none in source, in client bundles (any client-exposed env prefix is
   public), in logs or in error-tracker payloads. Scan git HISTORY, not only the
   current tree. A secret ever committed is compromised: revoke or rotate it at
   the provider; removing it from code is not enough.
5. Inputs: validate type, size and allowed values server side; no string-built
   queries; error messages do not leak internals.
6. Database: client roles have no grants on private tables (check table AND
   column privileges); security-definer functions pin search_path and are
   executable only by the intended role.
7. Abuse and cost: unauthenticated paths that trigger paid calls or writes need a
   dedicated secret or auth, rate limits and caps.
8. Prove each finding with a minimal non-destructive reproduction, classify it
   (confirmed / suspected / not tested), fix it on a dedicated branch with a
   regression test that fails before the fix, and check that legitimate access
   still works.

## Safety
- Active tests only on local or on a test environment proven to belong to the
  project; verify the real destination of every config before any network call.
- Never test against production or provider infrastructure without explicit
  authorization; no denial of service, mass extraction, real data deletion,
  messages sent or paid usage.
- Never print secret values; mask them in reports and name the rotation needed.
- Do not disable a protection or silence an alert to make tests pass.
- Never claim complete security; list what was not tested and why.

## Verification
- Each confirmed finding has a reproduction, a fix and a regression test that
  fails on the old code.
- Account A cannot reach account B data on every changed path; A still reaches A.
- Compromised secrets are listed with the rotation action and owner.
- Migrations are prepared, not applied to production without approval.
