# Mind Autopilot — autonomous Claude/Codex review loop

This is **opt-in** and **disabled by default**. It extends the existing Mind,
Brain and Orchestrator; it is not a second scheduler or a separate agent app.

## Lifecycle

1. Claude discovers a specific, evidence-backed next task from the repository,
   Mind learning nodes and pending insights; returns structured JSON. Its five
   work categories are: correctness, performance, quality, cleanup, testing.
   All categories require concrete evidence; performance additionally requires
   a reproducible baseline with benchmark command, conditions, and measurement.
2. Codex independently reviews the plan. On rejection, Claude must replan.
3. Claude implements in an **isolated Git worktree**.
4. Codex reviews the actual diff against the base commit, tests and regressions.
   Performance changes require before/after measurements on comparable workloads.
   Cleanup/refactoring must demonstrate unchanged external behavior.
5. On rejection, Claude fixes the findings, then Codex repeats its review.
6. On pass, the worktree is preserved for human review. The autopilot history
   stores category, task evidence, reviewer findings and worktree information.
   Mind also records completed CLI tasks via the existing Orchestrator integration.
7. After a cooldown, Mind discovers another task. If there is no justified
   task, it backs off instead of manufacturing work.

The loop **never merges, pushes, deploys, or deletes worktrees**.
It permits **2 successful tasks and 2 Claude discovery calls per UTC day**,
at most 1 plan revision and 1 code repair per task. A failure pauses the loop.

## Token and call budget (Mind Autopilot only)

Mind runs a deterministic, local Git scan first (tracked source files, TODO/
FIXME markers and recent commits). If there are no source files or code markers,
it makes **no discovery model call**. Discovery, code changes and reviews use
focused prompts and suppress the Orchestrator's extra Mind/skills/ledger context
hints. Autopilot passes `noRetry: true` and `noFallback: true` to CLI spawns,
so hidden provider retries and cloud fallback do not bypass the call budget.

Defaults, counted per **UTC day** and saved in
`.symphonee/mind-autopilot.json`:

| Guardrail | Default |
| --- | ---: |
| Successful tasks | 2 / day |
| Claude discovery calls (including replans) | 2 / day |
| Total Claude + Codex launches | 12 / day |
| Conservative charged token budget | 120,000 / day |
| Reservation when usage unavailable | 12,000 tokens / call |
| Plan revisions | 1 / task |
| Code repairs | 1 / task |

A normal completed task uses four calls (Claude discovery, Codex plan review,
Claude implementation, Codex code review). Therefore two simple tasks typically
need eight calls. Two repairs can bring the total to ten; the 120,000-token
reservation budget admits ten *unmetered* calls. If actual per-task usage is
reported, the ledger reconciles the reservation to that value. Otherwise the
12,000-token reservation remains a conservative **estimate**, not an actual
token count. A task can consume more tokens than its reservation before finishing.
**This is not a guaranteed provider-enforced token or billing cap.** The
number of new autopilot launches, unlike token consumption inside a CLI process,
is capped strictly by the dispatcher.

When the budget runs out between stages, Mind keeps its state and waits until
the following UTC day rather than launching another worker. A restart with
unfinished work always requires manual inspection and acknowledgment.

Check counters with:

    Invoke-RestMethod 'http://127.0.0.1:3800/api/mind/autopilot' |
      Select-Object -ExpandProperty budget

The counters include actual measured token usage where available, estimated
reserved tokens for unmetered calls, remaining budget and Claude/Codex totals.
They do not cover manual AI sessions, other Symphonee automations or API
accounts outside Mind Autopilot.

## Enable for the selected repository

Open Symphonee, select the target repository and use PowerShell:

    $body = @{
      enabled = $true
      goal = "Fix proven bugs; optimize measured bottlenecks, improve maintainability, clean dead or duplicated code, and add useful tests. Preserve behavior and avoid duplicate work."
    } | ConvertTo-Json
    Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/mind/autopilot/configure' -Method Post -ContentType 'application/json' -Body $body

Inspect the status:

    Invoke-RestMethod 'http://127.0.0.1:3800/api/mind/autopilot'

Stop immediately (cancels the current task; preserves its worktree):

    Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/mind/autopilot/stop' -Method Post

Run one immediate poll without waiting for the 20-second timer:

    Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/mind/autopilot/tick' -Method Post

If an interrupted run remains, inspect its worktree first, then explicitly
acknowledge it before starting a fresh run:

    $body = @{
      enabled = $true
      acknowledgeInterrupted = $true
      goal = "Improve verified correctness without duplicating completed work"
    } | ConvertTo-Json
    Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/mind/autopilot/configure' -Method Post -ContentType 'application/json' -Body $body

The status reports the current stage, task ID, rejected findings, and the
finished worktree branch/path. This first release intentionally provides a
backend/API control surface; a visual Mind tab control can be added separately
without compromising the existing renderer bundle.

## Safety and operational limits

- No autopilot executes until enabled locally by an explicit API call.
- Claude implementation and repair use the existing Orchestrator auto-permit
  mechanism. **Auto-permit can bypass CLI approval prompts, and a Git worktree
  is not an operating-system sandbox.** Only enable on trusted local repos and
  users; do not expose the server endpoint to untrusted networks.
- Codex gates are separate tasks and do not approve their own code.
- Structured, explicit PASS/FAIL is required; unknown outputs fail closed.
- A missing git diff, interrupted process, task failure or timeout pauses.
- Reboots do not blindly resume unfinished edits.
- The loop is scoped to the selected repository and does not change repositories
  when the UI changes.
- Provider costs and local compute still apply. The token reservation is not
  a hard provider billing cap; actual usage may exceed a reservation.
- Daily call and token limits apply only to this Mind Autopilot instance; they
  are not account-wide quotas and do not protect other agents or automation.
- Never raise the limits solely to consume more budget: review usage first.
- An improvement proposal requires concrete repository evidence (not a generic
  "code could be cleaner" claim).
- Performance optimization requires measurable before/after comparisons. If no
  reproducible baseline exists, the plan is rejected.
- Cleanup, refactoring, and architectural improvements must preserve public
  behavior; Codex must flag unrelated churn and unintended API changes.
- Mind may choose NO_TASK when no safe, independently testable benefit exists.
- Human review is still required before integrating worktree changes into the
  main branch.

## Test

    node --test dashboard/mind/autopilot.test.js dashboard/mind/autopilot-budget.test.js

Full project suite:

    npm run test:server
