# Model Router

**Do NOT hardcode CLI + model.** Use the router so picks respect the user's orchestration allowlist and API keys.

## How

```bash
# From bash
powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Get-ModelRecommendation.ps1 -Intent quick-summary"

# From API
curl -s -X POST http://127.0.0.1:3800/api/models/recommend \
  -H "Content-Type: application/json" \
  -d '{"intent":"quick-summary"}'
# -> { "cli": "claude", "model": "claude-haiku-4-5", "reasoning": "..." }
```

Feed the returned `cli` + `model` into your spawn body (`POST /api/orchestrator/spawn`) or graph-run worker node.

## Intents

- `quick-summary` — short output, classify, haiku, 1-paragraph answer
- `deep-code` — complex refactor, debugging, architecture
- `plan-and-implement` — reason then code
- `long-autonomy` — multi-hour agentic work
- `web-research` — needs current info from the open web
- `web-research-cheap` — light web lookup (pricing, docs)
- `pr-review` — pull-request / issue review workflow (plugin-dependent)
- `social-live` — live X/Twitter context
- `parallel-fanout` — one of N cheap workers
- `large-context` — input > 200k tokens (auto-promoted if `contextTokens` passed)
- `context-compression` — compress / condense a context packet (local first)
- `code-review-readonly` — read-only code reading / simple review (local 7B first)
- `small-edit` — 1-2 file edit, a shell command, a targeted test (Codex OSS local first)

Budget flag (optional): `cheap`, `default`, `premium`.

Full catalog: `curl -s http://127.0.0.1:3800/api/models/catalog`

## When to skip the router

- User explicitly asked for a specific CLI or model
- The intent is already obvious from a previous router call in this session
- You're testing the router itself
- The task fits the LOCAL DIRECT tier below (skip the router *and* every CLI)

## Local tier -- LOCAL-FIRST routing (built into the orchestrator)

This machine runs LM Studio on `http://127.0.0.1:1234` with Qwen2.5-Coder. The orchestrator
routes to it automatically: spawn with `"cli": "auto"` and the router picks by **capability
class**, local first when the local model can actually do the job.

Local providers (locality is explicit in `orchestrator/local-providers.js`; `qwen` is Qwen Code
on DashScope = CLOUD, never local):

| Provider id | What | Used for |
|---|---|---|
| `lmstudio-qwen-small` | direct LM Studio, Qwen2.5-Coder 1.5B | summary, extraction, classification, rephrasing, context compression |
| `lmstudio-qwen-review` | direct LM Studio, Qwen2.5-Coder 7B | read-only review / explanation of content that fits 32k |
| `codex-oss-local` | `codex exec --oss --local-provider lmstudio` (1.5B) | NOT auto-routed by default (measured: 273s then "DONE" with no edit). Opt in with `LocalFirst.enableCodexOssSmallEdit: true` |
| `claude-local` | Claude Code on LM Studio | explicit opt-in only, never auto-routed |

Routing matrix:

| Task class | Primary | Fallback | Retry policy |
|---|---|---|---|
| simple | `lmstudio-qwen-small` | cheapest capable cloud, then premium | 1 local attempt, then cloud |
| readonly-review | `lmstudio-qwen-review` | capable cloud (claude/codex) | 1 local attempt, then cloud |
| small-edit (edit, tests + fix) | codex / claude cloud directly | next cloud | cloud policy |
| complex | cloud (quality >= 4) directly | next cloud | cloud policy (MAX_RETRIES=2 on transient errors) |
| security | top-quality cloud directly | next cloud | cloud policy |

Rules the code enforces:
- Local is only eligible when LM Studio answered a fresh probe, the model is installed, the task
  fits its context (Codex OSS carries ~20k tokens of its own prompt), and the RAM guard passes
  (a model is loaded with `lms load --context-length 32768 --ttl 900`; the 7B is never stacked on
  another resident LLM). Unknown == unavailable: fail closed to cloud.
- A local provider gets exactly ONE attempt. Any failure (LM Studio down, load failure, context
  overflow, timeout, empty output, tool error) fails over to cloud immediately. Fallback chains
  are cloud-only and de-duplicated: never local -> local, never a loop.
- Local runs never see a cloud credential: every cloud API key is stripped from the child env,
  `codex-oss-local` argv is verified to be pinned to `--oss --local-provider lmstudio` (refuses to
  start otherwise), direct calls only go to a loopback URL. `task.execution.locality` says
  `local` or `cloud` on every task.
- An explicit user preference (`preferredProvider` / `PreferredProvider`) always wins.
- A spawn that names a local provider explicitly (e.g. `"cli": "lmstudio-qwen-small"` from a
  model-router recommendation) gets the same cloud fallback chain; pass `task.noFallback: true`
  to opt out. Cancelling a task never triggers a failover.
- A local provider that just failed is in cooldown (no new local attempt) unless the failure was
  caused by the task itself (prompt too large, repo content not available to a tool-less model).
- Classification reasons on the INSTRUCTION: for "summarize/classify/extract/compress/translate:
  <payload>", words inside a pure-data payload (ticket list, log, text to translate) do not change
  the route; but a payload that gives the agent an order (then/also/puis/ensuite + action,
  "supprime-les", "commit it", an imperative line, a destructive command, a file to rewrite,
  repo-wide scope, a security question about code) is analysed like a task. Known limit: this is
  keyword analysis; an unusual phrasing can still reach the local 1.5B, which can only answer in
  text (it cannot perform the action). A model-side "reply NEEDS_TOOLS" guard was measured on the
  real 1.5B and rejected (it refused 5 of 9 plain text tasks).
- Automatic fallbacks never start a CLI that the permission rules DENY (explicit deny rule or
  review mode); a blocked candidate emits a `fallback-blocked` event.
- `LocalFirst.enabled: false` in config turns the whole local tier off.

Observability:
- `GET /api/orchestrator/routing-stats[?since=ISO]` -> counts per route: `LOCAL_DIRECT`,
  `LOCAL_CODEX`, `CLOUD_DIRECT`, `LOCAL_TO_CLOUD_FAILOVER` (+ one-line summary and recent records).
  Persisted in `.ai-workspace/orchestrator/routing-telemetry.jsonl`.
- `GET /api/orchestrator/local-health` -> live LM Studio probe + eligibility per local provider.
- Per task (`GET /api/orchestrator/task?id=`): `execution`, `routeCategory`, `taskClass`,
  `routingReason`, `failedOverFrom`, `routingHistory`.

Model-router intents with a local first choice: `quick-summary`, `context-compression`
(`lmstudio-qwen-small`), `code-review-readonly` (`lmstudio-qwen-review`), `small-edit`
(`codex-oss-local`). They are only recommended when LM Studio is live and the context fits.
