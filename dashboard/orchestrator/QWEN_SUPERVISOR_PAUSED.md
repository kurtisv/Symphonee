# Qwen independent supervisor: paused work

Status: paused at user request. Keep all production Qwen locks enabled.

## Verified work

- The native Windows Codex CLI reported ChatGPT login. A fictional review
  identified an arithmetic overflow, but did not establish production isolation.
- A Linux Codex 0.169.0 binary ran in an offline inspected Docker container.
  An offline app-server probe reached a fake loopback service with fake credentials.
- Git-blob snapshots and a restricted pure JavaScript assertion interpreter
  were developed. The interpreter is not a native JavaScript execution proof.
- Experimental relay and Docker resource-journal modules have simulated tests;
  neither is connected to a production reviewer.

## Blocking gaps

- Windows Job Objects alone do not contain processes created through WMI.
  Full process lifecycle isolation and cleanup are not verified.
- Docker Codex authentication, a bounded trusted egress path, and recovery from
  ambiguous late Docker creation are not integrated or verified.
- Codex app-server requests include dynamic content and an input tool, so the
  current pre-hashed relay policy does not establish a safe actual review.
- No real-project diff may be accepted or applied based on experimental helpers.

## Resume criteria

Obtain a verified containment and cleanup boundary, consented authentication,
trusted review provenance bound to the exact tested diff, independent technical
evidence, adversarial tests, and a real end-to-end fictional review. Keep the
provider disabled until those guarantees and an independent review pass.

## Separate fixture correction experiment

`qwen-fixture-loop.js` is a simulation-only coordinator, not a production
orchestrator route. It allows 15 attempts, and up to 20 only when the count of
independently passed assertions improves in attempts 11-15 over attempts 1-10.
It stops on a repeated proposal, persistent identical failure, budget exhaustion,
deadline, cancellation, invalid evidence, or a reported security incident.

In one manually run fictional sign-function case, local Qwen3 4B supplied text
only. A simulated reviewer rejected the first proposal for a missing final
semicolon; Qwen's second proposal passed the three restricted-interpreter
assertions and the simulated review. The model reported 293 local tokens.
No generated code was executed natively and the original fixture Git tree was
not changed. The run history is stored locally under
`.ai-workspace/qwen-fixture-history/` and is not yet integrated with Mind.

The separate average-function trial stopped after repeated unsupported syntax;
this is not proof that arbitrary JavaScript is supported. The real Qwen Docker
provider and the native Codex reviewer remain blocked; no real project is
authorized by the simulated reviewer. Cancellation is demonstrated for
cooperative callbacks, not as proof of termination for an uncooperative process.

## 2026-11-15 real fixture demonstration: NO-GO (no approval obtained)

The in-container `runAssertions` call is removed from the adapter. The host's
restricted verifier now checks each trusted case on the diff reconstructed from
the frozen Git snapshot (`assessReconstructedFixture`); false assertions,
unsupported syntax, timeouts, tool failures and missing evidence are returned
to the developer as observations and are never a validation. The real-project
lock (`INDEPENDENT_ASSERTIONS_VERIFIED = false`) is unchanged. The fixture-only
entry `spawnQwenFixture` requires an in-process capability and a temporary
standalone repository without remotes.

The existing autopilot stages implement, code-review and repair run in a Qwen
fixture mode (capability only, no route, no definition file, no Sentry report,
no repository lesson, no discovery afterwards). Codex reviews through
`spawnHeadless` with `reviewerNoTools` (see QWEN_REAL_REVIEW_LIMITS.md).

Five manual runs on the fictional `average` fixture
(`qwen-autopilot-fixture.manual.js`, history in
`.ai-workspace/qwen-fixture-history/`): six real Codex reviews, all NO-GO and
all justified (the intermediate sum overflows for very large values). Each
accepted review declared only `request_user_input`, emitted only an
`agent_message` and left no descendant process; measured Codex usage was about
6,000 tokens per review (5,828-5,849 input, 176-229 output). Qwen3 4B used
28,000-47,000 local tokens per measured attempt. Qwen never produced an
overflow-safe expression inside the verifier's subset; many attempts failed on
unsupported `const`, tool errors or the 150 s Qwen limit. Run 1 used a
requirement demanding exact summation, unsatisfiable in the subset; it was
corrected for later runs. Run 2 was killed by the host for low memory and left
its Docker worker, relay and network, removed by hand: cleanup is not
guaranteed when the parent process is killed. Mind recorded run 1 and run 3
observations in isolated fixture spaces at proof levels
`real-codex-review-fictional-fixture` and `independent-checks-only`, read back
from a fresh process; `verifiedLessons()` stays empty.

Not demonstrated: a Codex approval after a Qwen correction, hence no GO. Next
minimal step: a fixture whose correction a 4B model can reach, or a stronger
local developer model, with the same chain unchanged.
