# Qwen3.5-4B as a local developer on real repositories (EXPERIMENTAL, opt-in)

Qwen runs locally (LM Studio), in TEXT mode: it has no native tools. It works through a host protocol, inside one
isolated git worktree. It is the first candidate for small, located tasks of an autopilot; Claude stays the fallback.
Nothing is merged, pushed or deployed automatically.

## Protocol (`qwen-repo-worker.js`)
Each turn the model writes text; only action lines are executed, at most 4 per turn:
`LIST`, `READ path [from-to]`, `GREP text [IN dir]`, `EDIT path` + SEARCH/REPLACE block (exact, unique match), `CREATE path` + CONTENT block
(a file the model created itself may be rewritten whole), `PLAN`, `STEP-DONE`, `NOTE`, `RUN`, `DONE`, `STUCK`.
No shell, no arbitrary path. Paths are confined to the worktree (no `..`, absolute, `.git`, or links); the pilot's protected
paths can be neither read nor written, and anything protected that appears is reverted. `RUN` executes the repository's own check commands
(the pilot's `verify` list) on the host. `DONE` is believed only if those checks pass.

## Guard rails: progress and resources, not Qwen's tokens
Unchanged re-runs; the same failure repeated (three times forces a different strategy, three such switches maximum); identical or A/B/A/B turns (two warnings);
26 turns without any change; a premature `STUCK` (refused twice with an explanation); free RAM (waits up to 3 minutes, then pauses);
LM Studio health and model context; the work-window and step deadline. Progress (plan, notes, turn log, failures) is saved in
`.symphonee/qwen-sessions/*.json`, so a paused or restarted task resumes in the same worktree.

## In the autopilot (`mind/autopilot.js`, `orchestrator/spawn-qwen-repo.js`)
Enabled per pilot by `qwen: { enabled: true }` in `.symphonee/mind-autopilots.json` AND `QwenRepo.enabled` in `config/config.json`.
Admissible = the plan names 1 to 4 tracked, unprotected files totalling at most 48 KB. Otherwise Claude implements as before and the reason is logged.
Qwen consumes no cloud call. Its change then goes through the usual gates: main checkout fingerprint, protected paths, the repository's checks, Codex code review, commit on the task branch only.
Qwen repairs (up to 2) come first, then Claude. If Qwen is stuck: with changes, Claude continues in the SAME worktree (not counted as a repair); without, Claude implements from scratch and the empty worktree is kept.
A paused Qwen (RAM, LM Studio, end of the window) resumes at the next opportunity, up to 12 times. History records who wrote the change:
`qwen`, `qwen+claude-repair`, `claude-after-qwen` or `claude`; observations from a blocked Qwen are recorded as NON-certified lessons.

## Install, status, rollback (reversible)
`node dashboard/orchestrator/qwen-repo-install.manual.js status|install|rollback <liveDir>`. Install refuses unless every file it would overwrite equals origin/master,
backs them up under `.symphonee/backups/qwen-install-*`, copies only runtime files, sets the two flags above and does not touch schedules, goals, checks or the `enabled` flags.
A running Symphonee keeps the old code until it is restarted.

## Real trials (2026-11-15, Symphonee source repo, `dashboard/startup-trace.js` has no test)
Four runs, local only, main checkout unchanged each time. 1: 44 turns reading, RAM guard paused it. 2: read/DONE loop, 26 turns without a change, handed back. 3: wrote
`dashboard/startup-trace.test.js` in 78 s, host checks failed (assertions about shared state), gave up after one failure. 4: wrote a test file with a syntax error
(`const { get marks }`), two failed runs, handed back. No trial reached passing checks: this model needs help on this kind of task, and the hand-back to Claude is the designed path.
Findings that changed the code: a model follows a worked example better than a description; it must be told to write after reading; it gives up too early; it repeats in cycles.

## Limits
Single 8k-context text model: no multi-file reasoning beyond a few small files; no certified lessons yet for real repositories (certification needs an independent proof and Codex review);
the fictional-fixture lock of `spawn-qwen-docker.js` is unchanged and unrelated; LoRA training is a separate mechanism, not part of this.
