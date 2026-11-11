# Mind Autopilot - autonomous Claude/Codex review loop

This is **opt-in** and **disabled by default**. It extends the existing Mind,
Brain and Orchestrator; it is not a second scheduler or a separate agent app.

**Where:** Symphonee > Mind tab > **Autopilot** sub-tab. Everything below can be
done there (Activer / Arreter / Verifier maintenant / Archiver); the REST routes
are listed at the end for scripts.

## Lifecycle

1. A local, token-free Git triage runs first (tracked sources, TODO/FIXME
   markers, recent commits, dirty files). No signal means no AI call.
2. Claude discovers ONE evidence-backed task (READ-ONLY: edit tools disallowed,
   never inherits the global bypass/trusted permission mode) and returns JSON.
   Categories: correctness, performance, quality, cleanup, testing. Performance
   additionally needs a reproducible baseline.
3. Codex reviews the plan independently (read-only sandbox). On FAIL, Claude
   revises it once, with the rejected plan and findings; a second FAIL stops
   the task. Nothing is implemented without a PASS.
4. Claude implements in an **isolated Git worktree** (`../.worktree-<task>`,
   branch `mind-autopilot/<day>-<id>`), with `--permission-mode acceptEdits`
   (edits only inside the worktree), an allow-list of test runners and
   read-only git commands, and a deny-list (push, merge, rebase, reset, branch,
   checkout, worktree, commit, npm publish/install, npx, web tools). The user's
   main checkout is fingerprinted before and after; any change halts the pilot.
5. Codex reviews the real diff and runs tests in its read-only sandbox. The
   worktree is fingerprinted (HEAD, diff, untracked content) before and after:
   a reviewer that changes anything voids the review and halts the pilot.
6. On FAIL, Claude repairs once (same confinement), then Codex reviews again.
7. On PASS the task is recorded as completed and the worktree is **kept for
   human review**. Nothing is merged, pushed or deployed. After a cooldown the
   next admissible task may start.

## Daily limits (local calendar day, persisted in `.symphonee/mind-autopilot.json`)

| Guardrail | Limit |
| --- | ---: |
| Successful tasks | 3 / day |
| Claude discoveries (including plan revisions) | 6 / day |
| Claude + Codex launches | 20 / day |
| Reservation token budget | 3,000,000 / day |
| Reservation when real usage is unknown | 150,000 tokens / call |
| Plan revisions | 1 / task |
| Code repairs | 1 / task |

Every launch is reserved **before** it starts and stays charged even if it
fails. `noRetry` and `noFallback` are always passed, so no implicit retry or
provider fallback can create an uncounted call.

**Real usage** is recorded when the CLI reports it: Claude via
`--output-format json` (input + cache creation + cache read + output), Codex
via its `tokens used` line. Otherwise the per-call reservation is shown in the UI
as an *estimation*. The token budget is checked before each launch; it is
**not** a cap enforced inside a running CLI, so a single call can overshoot.

Measured on this machine (2026-11-11): a trivial Claude `-p` call is ~21,600
tokens (mostly cache); one Codex review of a ~1,400-line diff was 107,569
tokens. The limits were raised on 2026-11-11 (user decision) from these figures:
a typical task is ~715k tokens, ~1.33M with one plan revision and one repair, so 3M admits two worst-case tasks per day plus margin (20 launches >= 2 x 8).

## Restart and stop

- Arreter cancels the running Orchestrator task (its reservation is settled).
- Restarts are part of the loop. A stage is **never replayed**:
  - pilot active and parked on quota: it keeps waiting;
  - pilot active with a stage running: that run died with the old server; it
    is archived as *interrupted* (reservation kept charged, worktree kept on
    disk), and the loop continues with a fresh discovery after 5 minutes;
  - pilot stopped by the user: it stays stopped (*Interrompu*) until the user
    archives the task.
- Configuration, consent, history, events and the call ledger survive restarts.
- `scripts/Restart-Symphonee.ps1` restarts the app through `/api/restart-app`,
  verifies the old process is gone, and resumes each Claude session in its own
  terminal (`-Resume term-3=<session> -Continue term-3=continue`). It detaches
  itself, so it can be run from inside a Symphonee terminal.

## Consent

Activation requires `allowWorktreeWrites: true` (the checkbox in the UI). It is
recorded with a timestamp and repository path, and reused only for the same
repository. This is tool-level confinement, **not an operating-system
sandbox**: an allowed test runner executes repository code. Enable only on
trusted local repositories.

## Network exposure

The server binds `127.0.0.1` only, rejects cross-origin / DNS-rebinding
requests, and every POST needs the per-boot `x-symphonee-token`.

## REST routes

    GET  /api/mind/autopilot                 status, stage, limits, budget by provider, history, events
    POST /api/mind/autopilot/configure       { enabled, goal, repoName, allowWorktreeWrites }
    POST /api/mind/autopilot/stop
    POST /api/mind/autopilot/tick            immediate check (the timer ticks every 20 s)
    POST /api/mind/autopilot/acknowledge     archive an interrupted task (worktree kept)

## Tests (no paid tokens; fake CLIs, real Orchestrator, real worktrees)

    node --test --test-force-exit dashboard/mind/autopilot.test.js dashboard/mind/autopilot-budget.test.js dashboard/mind/autopilot-integration.test.js dashboard/orchestrator/spawn-headless.test.js
    npm run test:server
    npm run test:renderer
