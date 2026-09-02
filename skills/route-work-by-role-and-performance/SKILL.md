---
name: route-work-by-role-and-performance
description: Choose the smallest useful set of agents by measured performance, capability, health, quality, token cost and independence when a task benefits from automatic multi-agent planning, delegation, testing or review.
metadata:
  short-description: Route multi-agent work efficiently
---

# Route work by role and performance

## Use when

- A task contains one or more roles such as investigation, coding, debugging, testing or review.
- AUTO routing is enabled.
- Work can benefit from delegation or independent verification.

## Do not use when

- User explicitly selected a provider/manual mode.
- The task is too small to justify decomposition.
- Safety requires human/provider-specific intervention.

## Steps (primary path)

1. Classify the requested work into roles and task characteristics.
2. Build the smallest useful role-based workflow. Keep simple or deterministic work local; do not delegate merely because providers are available.
3. For every role, retrieve eligible providers from the provider registry.
4. Exclude disabled, unavailable, incompatible or cooling-down providers.
5. Score remaining providers using role capability, measured role performance, confidence, quality requirement, health, quota state, cost tier, measured tokens per successful task, speed and user routing policy.
6. Select the highest-scoring provider that satisfies the role's quality threshold.
7. For review, prefer a capable provider different from the author.
8. Execute the step.
9. Hand results to dependent steps using a bounded Context Packet instead of full conversation history. Include only the goal, decisions, changed files, relevant diff, test evidence, blockers and unresolved questions.
10. On eligible provider failure, use the existing fallback/cooldown mechanism and continue the same workflow.
11. Record routing outcome and measurable success/failure signals.
12. Update provider role performance only from reliable observable evidence.
13. Continue until all workflow dependencies are complete or the workflow needs human attention.

## Token economy

- Prefer Mind/local answers for recall and simple synthesis before a frontier model.
- Set `routingPolicy: ECONOMY` for summarization, extraction, classification, context compression and other low-risk work.
- Reserve high-quality providers for complex implementation, security-sensitive work and final review.
- Give reviewers the relevant diff and contracts, not the whole repository transcript.
- Use an idempotency key for retried `/api/orchestrator/spawn` requests. If an equivalent task is already active, reuse it instead of spawning another worker.
- Reuse a saved recipe or file reference for long stable instructions; send only the task-specific delta.
- Use deterministic code for calculations and assertions. Do not spend model tokens judging facts a test can compute.
- Consult `/api/orchestrator/economy` to report measured coverage, token usage, context overhead and duplicate spawns avoided. Never claim exact monetary savings when provider usage is unmeasured.

## Quality invariant

- Optimize cost per accepted result, not raw token count. A cheaper attempt that requires rework is not a saving.
- Preserve the task's explicit quality requirement and raise it for production, security, destructive, architectural or difficult debugging work.
- Use measured success and rework history before preferring a cheaper provider. With insufficient evidence, keep the configured quality gate.
- Do not compress away acceptance criteria, safety constraints, changed-file boundaries, failing evidence or test commands.
- Escalate only the unresolved delta. Preserve verified work in the Context Packet so the stronger provider does not repeat completed investigation.
- Run an independent review only when risk or user intent justifies it; routine deterministic work should finish with deterministic checks.

## Safety

- Never bypass provider quota/rate limits.
- Never invent quota remaining.
- Never place secrets in routing data, Context Packets or Skills.
- Never expose hidden chain-of-thought between providers.
- Never treat one provider as permanently best for a role.
- Do not let quota/auth/network errors incorrectly reduce measured task skill.
- Do not run unsafe concurrent repo mutations.
- Manual provider choice must remain authoritative.

## Verification

- AUTO tasks show selected role, provider, routing score/reasons and routing history.
- Multi-role work may use different providers automatically.
- Reviewer independence is preferred and visible.
- Provider performance evolves from observable outcomes.
- Fallback preserves workflow progress.
- Context handoffs remain compact.
- `/api/skills` lists this Skill after creation.
