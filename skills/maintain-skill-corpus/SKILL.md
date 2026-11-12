---
name: Maintain the skill corpus
description: Audit Symphonee skills and proposals, consolidate duplicates, reject weak recommendations, and keep only useful reusable procedures.
when: the user asks to review, improve, accept, reject, recommend, or clean up skills
tags: skills, maintenance, catalog, core
---

# Maintain the skill corpus

Skills are procedures, not facts. Maintaining them means keeping the catalog small,
canonical, actionable, and safe so every CLI can reuse the same workflow.

## Use when
- The user asks to review, improve, accept, reject, or clean up skills.
- `/api/skills/proposals` contains recommendations that need human-quality review.
- The catalog has near-duplicates, malformed bodies, vague steps, or one-off command
  sequences pretending to be reusable procedures.

## Do not use when
- The request is only to use one known skill for a normal task.
- The item is durable knowledge rather than a repeatable workflow; put that in Mind.

## Steps (primary path)
1. Inventory first: `GET /api/skills`, then fetch relevant bodies with
   `GET /api/skills/item?id=<id>`. Do not judge from the catalog summary alone.
2. Inspect recommendations: `GET /api/skills/proposals` and
   `GET /api/skills/reflection`. Treat proposals as evidence, not truth.
3. Classify each candidate:
   - keep: clear reusable procedure with real guardrails;
   - improve: useful idea but missing canonical sections or safety;
   - reject: one-off command, project fact, duplicate, malformed body, or low evidence;
   - consolidate: several skills describe the same procedure.
4. Prefer improving a stable existing id over creating a duplicate. Create a new
   skill only when no existing id can carry the procedure cleanly.
5. Write or update bodies with exactly these sections: `Use when`, `Do not use when`,
   `Steps (primary path)`, `Safety`, `Verification`. Steps must be ordered and
   concrete; safety must name the failure mode the skill prevents.
6. Reject weak proposals with `POST /api/skills/proposals/reject { id }`. Accept a
   proposal only when its body is already reusable, safe, and model-neutral.
7. Delete or retire duplicate/malformed skills only when they are not carrying a
   unique reusable procedure. Preserve core workflow skills.
8. Verify with `GET /api/skills`, selected `GET /api/skills/item`, and if relevant
   `GET /api/skills/proposals`. Save the result to Mind.

## Safety
- Do not accept auto-generated proposals blindly. A repeated command is not a skill.
- Do not store secrets, credentials, client-private details, or raw transcripts in a
  skill body.
- Do not create several narrow variants where one canonical skill is enough.
- If deletion would remove a unique active workflow, update instead.

## Verification
- The catalog has fewer duplicates or clearer canonical procedures.
- Every kept/created skill has the required sections and concrete steps.
- Weak recommendations were rejected or left unaccepted with a reason.
- New knowledge discovered during maintenance was saved to Mind separately.
