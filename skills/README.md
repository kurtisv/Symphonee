# Symphonee Skills (the procedural layer)

Skills are model-neutral `SKILL.md` procedures for **how** to do a task the same way
every time. They are the procedural layer of Symphonee's cognitive loop, alongside:

- **Mind** = knowledge ("what we know / decided")  -> `/api/mind/*`
- **plugins** = integrations ("how to reach a system") -> `/api/plugins/*`
- **skills** = procedures ("how WE do a task, step by step") -> `/api/skills/*`

Every CLI sees a bounded relevant catalogue at bootstrap (`bootstrap.skills`)
and dispatched workers get the same selection. Full bodies load only on demand;
`GET /api/skills` remains the complete lightweight editor catalogue. Malformed
skills stay editable but do not enter injected catalogues.

## Layout

```
skills/
  <id>/
    SKILL.md
```

`SKILL.md` is frontmatter + a markdown body:

```markdown
---
name: Human-readable capability name
description: What it does and when to use it (one line -- shown in the catalog).
when: short trigger phrase (optional)
tags: comma, separated (optional)
---

# Title

## Use when
## Do not use when
## Steps (primary path)
## Safety
## Verification
```

## API

- `GET  /api/skills` -- catalog (name/description/when, no bodies)
- `GET  /api/skills/item?id=<id>` -- one skill, full body
- `POST /api/skills` -- author/upsert `{ id, name, description, when?, tags?, body }`
- `DELETE /api/skills/item?id=<id>` -- remove
- `POST /api/skills/reflect` -- analyze procedural evidence; `{ autoApply: true }`
  applies high-confidence candidates, `{ dryRun: true }` prevents writes
- `GET /api/skills/reflection` -- last inventory, results and token estimates
- `GET /api/skills/proposals` -- reviewable procedures and inventory repair tasks
- `POST /api/skills/proposals/accept` -- validate and accept (409 on stale targets)
- `POST /api/skills/proposals/reject` -- reject a pending proposal

Skill Gardener extends the existing reflection engine. Provenance is separate
under `.provenance/` and never enters SKILL.md or bootstrap. See
[Skill Gardener](../docs/skill-gardener.md) for evidence rules, scoring weights,
automatic thresholds, permission behavior and maintenance commands.

## Authoring

When the user corrects a procedure, or you find a repeatable better way, capture
it as a skill so no one has to teach it twice. See the `author-a-skill` skill for
the exact shape. Keep bodies model-neutral and plain ASCII; encode the Safety, not
just the happy path.
