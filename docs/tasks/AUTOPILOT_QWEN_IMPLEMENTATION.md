# Autopilot Qwen dashboard - draft implementation evidence

This branch is based on master edf4c7b. It is not deployed. Existing application configuration and live pilots were not changed.

## Implemented

- Only default and gas-saver accept the opt-in fallback profile. Separate Qwen cloud and worktree-write consent, explicit daily calls and estimated-token ceilings are mandatory. Defaults remain disabled.
- Author quota exhaustion may initiate Claude to Qwen handoff. Authentication, network, rate-limit, context and security errors do not. Codex remains the independent reviewer, with a fresh provider-capacity check and a ledger reservation before handoff.
- Persisted handoff state records source task, stage, process attempt evidence, worktree/base/fingerprint and bounded redacted checkpoint. Repeated source events cannot launch duplicate workers. Dispatch repeats readiness, consent, capacity, schedule and worktree checks after awaiting process proof.
- Windows author processes can run in an OS Job assigned before resume. A completion record is written only after the native descendant tree is empty. Cancellation without complete evidence fails closed. Qwen errors halt instead of bouncing providers. Restart, configure and resume cannot silently reuse uncertain ownership.
- Two dashboard cards show actual provider/stage, handoff, unknown Qwen quota, intervention needs, filtered history and advanced controls. HTTP/WebSocket ordering and coalescing prevent older responses overwriting newer state.

## Blocking runtime limitation

This is a DRAFT, not a runtime-ready Qwen rollout. Qwen CLI is absent on the validation host. The orchestrator has no verified Qwen write/read confinement adapter. Consequently `canConfineProvider('qwen', ...)` cannot currently authorize real handoff; the controller deliberately refuses it. An approved, independently validated confinement adapter and actual authenticated Qwen smoke test are required before activation. Native Windows Job proof does not prove termination of daemon-owned Docker/Podman workloads.

The positive controller tests inject readiness/confinement and fake providers. They prove policy/state ordering, not live Qwen authentication or sandbox enforcement. The Windows Job tests execute only harmless local Node processes, never paid CLIs.

Provider token ceilings are accounting reservations, not hard provider token limits. Qwen subscription remaining capacity is explicitly unknown. Reviewer availability is conservatively checked with fresh measured Codex windows; it cannot guarantee the provider will remain available after launch.

## Validation

- Final targeted runs: 61/61 (autopilot core, real-orchestrator/fake-provider integration, fallback policy) plus 37/37 (budget/capacity, process proof/Windows Job, frontend races/interactions), all exit 0. Official `node scripts/build-renderer.js` also exits 0.
- Fallback tests started red (missing policy module), then green. Coverage includes consent/caps, error classes, independent review reservation, termination failure, duplicate handoff, post-await consent revocation and blocked resume.
- Controlled Windows Job tests verify root exit with surviving descendant, inherited process exit status, cancellation without false proof, and hostile proof overwrite prevention.
- Existing autopilot integration fixtures read real local provider capacity on pristine master and failed 10/10. The fixture now injects fresh deterministic capacity and cleans fake-worker watchdogs; original assertions remain intact.
- Frontend tests and official renderer build pass. Screenshots in `evidence/autopilot-qwen/` use the actual renderer with synthetic API data in isolated Windows Edge, not the running Electron app. Live Electron integration, broad accessibility/theme checks and real cloud Qwen are unverified.

## Rollback and activation

No deployment or restart is needed to review this branch. Keep fallback disabled while reviewing. If later deployed with authorization, disable fallback for each stopped pilot through advanced configuration to revert author routing to existing Claude/Codex behavior. Retained uncertain handoffs intentionally require ownership investigation; do not delete their worktrees or force-resume them. Reverting the branch restores the previous UI and controller. Merge, deployment and restart require the user's final agreement.
