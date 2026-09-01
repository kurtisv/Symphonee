---
name: Route work by role and performance
description: Choose agents per workflow role using measured performance, capability, health, quality, cost and independence, then hand work off with compact context.
when: a task can benefit from automatic multi-agent planning, provider selection, delegation, testing or independent review
tags: orchestration, routing, multi-agent, performance, workflow, core
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
2. Build a minimal role-based workflow when multiple roles are required.
3. For every role, retrieve eligible providers from the provider registry.
4. Exclude disabled, unavailable, incompatible or cooling-down providers.
5. Score remaining providers using role capability, measured role performance, confidence, quality requirement, health, quota state, cost, speed and user routing policy.
6. Select the highest-scoring provider that satisfies the role's quality threshold.
7. For review, prefer a capable provider different from the author.
8. Execute the step.
9. Hand results to dependent steps using a bounded Context Packet instead of full conversation history.
10. On eligible provider failure, use the existing fallback/cooldown mechanism and continue the same workflow.
11. Record routing outcome and measurable success/failure signals.
12. Update provider role performance only from reliable observable evidence.
13. Continue until all workflow dependencies are complete or the workflow needs human attention.

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
