# Mind Autopilot — autonomous Claude/Codex review loop

This is **opt-in** and **disabled by default**. It extends the existing Mind,
Brain and Orchestrator; it is not a second scheduler or a separate agent app.

## Lifecycle

1. Claude discovers a specific, evidence-backed next task from the repository,
   Mind learning nodes and pending insights; returns structured JSON.
2. Codex independently reviews the plan. On rejection, Claude must replan.
3. Claude implements in an **isolated Git worktree**.
4. Codex reviews the actual diff against the base commit, tests and regressions.
5. On rejection, Claude fixes the findings, then Codex repeats its review.
6. On pass, the worktree is preserved for human review. Mind records the
   completed tasks via the existing Orchestrator-to-Mind integration.
7. After a cooldown, Mind discovers another task. If there is no justified
   task, it backs off instead of manufacturing work.

The loop **never merges, pushes, deploys, or deletes worktrees**.
Review/replan is capped at 2 iterations each; at most 2 successful tasks and
5 discoveries per UTC day. A failure pauses the loop with a recorded error.

## Enable for the selected repository

Open Symphonee, select the target repository and use PowerShell:

    $body = @{
      enabled = $true
      goal = "Improve the selected app's verified correctness, reliability and tests, without duplicating existing work"
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
- Provider costs and local compute still apply. No automatic spending limits
  or hard network egress restrictions are guaranteed by this version.
- The daily success limit is not an exact token budget. Review usage before
  raising limits.
- Human review is still required before integrating worktree changes into the
  main branch.

## Test

    node --test dashboard/mind/autopilot.test.js

Full project suite:

    npm run test:server
