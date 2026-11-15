# Teacher-assisted learning for the local Qwen developer (EXPERIMENTAL, fixture only)

Status: experimental branch `claude/qwen-teacher-learning`. Not merged. Qwen stays LOCKED for real
projects (`INDEPENDENT_ASSERTIONS_VERIFIED = false` in `spawn-qwen-docker.js`). Everything below runs on
FICTIONAL JavaScript functions in throwaway temp git repos, in an isolated Mind space.

## Idea

Qwen3.5-4B (LM Studio, text only, no tools) writes code. An independent checker (`qwen-pure-assertions.js`)
verifies it. A real tool-free Codex review must say GO. When Qwen repeats an equivalent failure, Claude is
asked ONCE to explain the cause and a method (never code). That explanation is only a hint: it becomes a
lasting lesson only after the independent checks and a Codex GO succeed on an attempt that was shown it.
No explanation is certified because Claude wrote it.

## Lifecycle (`mind/lessons.js`)

OBSERVATION -> TEACHING (explanation attached, not certified) -> VALIDATED -> OBSOLETE.

`validate()` refuses unless ALL hold: status `teaching`; independent checks passed (executed == expected);
real Codex GO (task id, 64-hex diff hash); reviewer provider `codex`, cleanup `verified-no-descendants`,
only tool `functions.request_user_input`; code/assertions hashes; checker version equals the current
`CHECKER_VERSION`; the lesson key was in the `shown` list of the validating attempt; at least 2 failed
attempts on the blockage; validation came after teaching; family set. Same method again merges evidence; a
different method for the same class supersedes; a changed checker or 90 days expires it.

## Entry points

- `mind/autopilot.js`: `shouldTeach`, `startTeaching`, `qwenTeachSettled`, `validateTaught`, `recallMethods`, `recordFixtureUses`, `qwenPrompt`.
- `mind/qwen-teaching.js`: `buildTeacherPrompt`, `parseTeaching` (rejects code/fences/module.exports), `leaksSolution`, `teacherSpawnOptions`, `teacherTokens`, `skillProposals`. Limits: 2 per task, 1 per blockage, 240 s.
- `mind/lessons.js`: `attachTeaching`, `validate`, `markObsolete`, `expireStale`, `selectForTask`, `validationProblems`.
- `mind/qwen-learning-fixture.js`: `upsertLesson`, `recallLessons`, `recordLessonUse`, `retireLesson`, `retireStale`, `listLessons` (nodes `qwen_lesson_<sha256>`, digest-verified, in the fixture Mind space only; reuses `brain/mind-context.js` retrieval, no second Mind and no second orchestrator).
- `orchestrator/qwen-teaching-demo.manual.js` (steps A, B1-B3, C0, C1, C2, C3) over `orchestrator/qwen-autopilot-fixture.manual.js`; tasks in `orchestrator/qwen-fixture-tasks.js`.

## Tests

`node --test --test-force-exit --test-timeout=120000 orchestrator/qwen-*.test.js orchestrator/codex-no-tools.test.js orchestrator/local-first.test.js mind/qwen-*.test.js mind/lessons*.test.js mind/autopilot*.test.js` from `dashboard/`:
271 tests, 269 pass, 0 fail, 2 skipped (Docker opt-in). `orchestrator/spawn-headless.test.js`: 8/8.

## Real runs (2026-11-15; raw numbers in `QWEN_TEACHING_RESULTS.json`)

Developer Qwen3.5-4B local; teacher Claude (headless, sonnet, tool-free); reviewer Codex tool-free. Tasks: `average` (overflow-safe mean, taught) and `meanAbs` (analogous, never taught).

| Arm | Runs | Approved | Notes |
|---|---|---|---|
| A: average, no teaching | 1 (+1 earlier) | 0 | stalled, 5 attempts |
| B: average, Claude teaches | 3 valid | 1 (B2) | B2 approved by Codex GO and its lesson VALIDATED into Mind; B1 failed (checks) |
| C0: meanAbs, no memory | 2 | 0 | stalled |
| C1: meanAbs, validated lesson from Mind | 2 | 0 | lesson retrieved and shown; Qwen reproduced the method's structure but dropped two task-specific adaptations and stalled |
| C3: meanAbs, Claude alone | 1 valid | 0 | checks failed |
| C2: meanAbs, Claude + memory | 1 valid | 0 | checks failed |

Two runs (C3a, C2a) were cut by a Claude usage limit and excluded; two earlier runs exposed bugs (teaching refused for length; validation refused because the blockage signature exceeded 600 characters), both fixed with regression tests and kept in the record as invalid.

Cost of the valid runs: Claude teacher about 23k tokens in total, Codex 6,570 tokens (one review), peak llama.cpp RAM 5.4 GB.

## What this does and does not show

- Shown: the whole mechanism works end to end with real calls: Claude teaches after repeated failure, Qwen then reaches a Codex GO once (B2), the lesson is validated, stored in Mind, retrieved in a new session and shown to Qwen.
- NOT shown: that memory improves results. On the unseen analogous task, with and without memory, 0 of the valid runs succeeded; memory changed the shape of the attempts but not the outcome. n is 1 to 3 per arm, so there are no rates and the single success (B2) is not evidence of causality.
- A lesson validated on `average` is literal (its traces name `average`); transfer to `meanAbs` needs more general lessons or more teachings.
- Fixture only. Production Mind, real repos and autopilot are untouched; the real-project lock is unchanged. A GO here is not authorization for autonomous development.

## Follow-up after the independent review (2026-11-15, no new AI calls)

- Mind write is now a separate step after local validation. If it fails, the lesson is recorded as pending (`state.mindSyncPending`), the log says "VALIDATED locally, Mind write FAILED", never "not validated"; `syncPendingMind()` retries (also before each recall) and the Mind upsert is idempotent per run id, so no duplicates.
- Stress evidence before promotion: when the family defines a wide check (`average` now has one, like `meanAbs`), the lesson is promoted only if it ran on at least 100 inputs with 0 mismatches. A check that cannot run blocks the promotion. The earlier B2 lesson was validated BEFORE this rule (its `wideCheck` was null), so it counts as unproven by the new rule.
- Not done yet: splitting each teaching into a general principle and an `average`-specific application, and a comparative experiment over several unseen tasks with identical conditions with and without memory. Raw session files stay local (gitignored), so the published numbers cannot be replayed from GitHub.
- Tests: 282 total, 280 pass, 0 fail, 2 skipped.

## Second round (2026-11-15): stress proof in the lesson, general principle, controlled memory experiment

Changes (tests: 293, 291 pass, 0 fail, 2 skipped, run before any AI call):
- The stress proof (`wideRequired`, `wide {inputs, mismatches}`) is stored with each validation and each history item, locally and in Mind. `isCurrent`/`lessonCurrent` now require it (`wideCertified`); freshness (checker version, expiry) is separate (`isFresh`). A lesson validated before this rule (no `wideRequired`) is kept with its history, listed as `certified: false`, never recalled as a certified method and never retired for it; a later run that carries the proof merges into it and upgrades it. Fail closed: a family that defines a stress check (`TASKS[].stress`) requires it even if the harness forgot to configure one. The B2 lesson of the first round is exactly such a legacy lesson.
- Each teaching now has a general `principle` (reusable, must not name the current function; 20-500 chars) and the existing `strategy` is its application to the current function. `principle` is optional in storage so old lessons keep working; a new teacher answer must carry it. The developer reads "General principle ... / Application to the problem it was taught on (adapt it, do not copy it)"; Mind recall matches on the principle too.

Experiment `mem-e1` (`orchestrator/qwen-memory-experiment.manual.js`, data in `QWEN_MEMORY_EXPERIMENT_RESULTS.json`, per-attempt code included). Preparation: Claude may teach on `average` (3 runs: P1, P2 checks-failed, P3 approved by Codex, lesson certified with 1500 stress inputs, 0 mismatches). Comparison: 3 unseen tasks (`meanAbs`, `midRange`, `meanPositive`) x 2 independent trials x {no memory, memory}, interleaved, same model and conditions, NO Claude, Codex only after the independent checks pass. Rule fixed before the runs: gain only if memory approvals - no-memory approvals >= 2 of 6 and memory is not worse on any task.

| | No memory | Memory |
|---|---|---|
| Approved (checks + Codex GO) | 0 / 6 | 2 / 6 |
| `meanAbs` | 0 / 2 | 2 / 2 (first attempt each time) |
| `midRange` | 0 / 2 | 0 / 2 |
| `meanPositive` | 0 / 2 | 0 / 2 |
| Mean attempts / seconds | 4.7 / 56 | 3.5 / 65 |
| Qwen tokens | 22,577 | 30,618 |
| Codex tokens (only after checks pass) | 0 | 13,377 (2 reviews) |
| Claude tokens | 0 | 0 |
| Peak llama.cpp RAM | 4,340 MB | 4,422 MB |

Whole experiment: Claude 4 calls / 15,931 tokens (preparation only), Codex 3 reviews / 19,973 tokens, Qwen 70,919 tokens.

Reading. The pre-registered rule is met (2 vs 0, nowhere worse), but the evidence is thin: n = 6 per arm, the whole difference comes from one task, and the difference is not statistically convincing (2/6 vs 0/6). What is real: on `meanAbs`, the closest analogue of the taught task, Qwen wrote a correct solution on its first attempt both times with the lesson, and the code shows the principle being adapted (divide each term before adding, absolute value added, clamp), whereas it stalled four times without it. On `midRange` and `meanPositive` the lesson was shown but there was no gain: the failures there are mostly checker limits (spread, other reduce shapes, counting) and a harder adaptation, not overflow. So: transfer to a near analogue is observed; transfer to a structurally different problem is not. No broader claim is made. Next: more trials and more varied tasks before any decision about real projects, which stay locked.
