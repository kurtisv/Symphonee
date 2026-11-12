---
name: Use Mind (recall, teach, save)
description: The cross-CLI memory discipline: recall prior work, teach durable corrections, save findings, and maintain the Mind graph without losing dynamic memory.
when: any substantive turn, especially prior-work questions, user corrections, code-structure questions, or Mind graph maintenance
tags: mind, memory, core, maintenance
---

# Use Mind

Symphonee is the brain; you are one of many mouths connected to it. Mind is the
ONLY surface that carries intelligence across CLIs and sessions. A turn that ends
without writing to Mind has wasted intelligence for every future session.

## Use when
- BEFORE answering: the user asks about prior work / past decisions ("what did we
  figure out about X", "didn't we...", "what do I know about X").
- WHEN the user teaches something durable ("remember", "from now on", "always",
  "never", "we decided", "prefer X", "the rule is", "watch out for") or corrects
  your earlier behaviour.
- DURING a code-structure question ("what calls X", "where is Z defined").
- BEFORE maintaining the Mind graph, rebuilding it, embedding it, or changing its
  memory/integrity state.
- AFTER every substantive reply.

## Do not use when
- Pure greetings or trivial chit-chat.

## Steps (primary path)
1. Recall first for prior-work questions: `POST /api/mind/recall { question, since?,
   until?, repo? }`. Cite the memory IDs that come back.
2. Query for code structure: `POST /api/mind/query { question }`. Cite returned
   node IDs only -- never invent IDs.
3. Teach durable facts the moment you hear them: `POST /api/mind/teach { title,
   body, kindOfMemory, tags, createdBy }`. You make the call when YOU hear the
   signal -- do not wait for the user to remind you.
4. For Mind maintenance, inspect in this order before writing: `/api/mind/lock`,
   `/api/mind/health`, `/api/mind/integrity`, `/api/mind/quality`, and only then
   choose update/build/embed. Prefer incremental update over full build.
5. Before any full `POST /api/mind/build`, preserve or verify a restorable graph
   backup/export. Full rebuild regenerates source-derived nodes and can drop
   dynamic memory cards if they are not persisted as an independent source.
6. Save after answering: `POST /api/mind/save-result { question, answer,
   citedNodeIds, createdBy }`. Keep the wording factual; avoid accidental teaching
   phrases unless you really want a memory card created.

## Safety
- Do not invent node IDs; cite only IDs returned from a query.
- Do not mark guesses as EXTRACTED -- inferred edges are INFERRED/AMBIGUOUS.
- Never record company/client names, URLs, secrets, or credentials in learnings.
- Do not delete Mind nodes without explicit user authorization.
- Do not run a full Mind rebuild casually. Check health and prefer update first;
  if a rebuild is necessary, make sure dynamic memories can be restored.

## Verification
- For a prior-work question, you recalled before answering and cited memory IDs.
- For a durable correction, a teach (or a save-result that auto-extracted it) landed.
- For graph maintenance, lock/health/integrity/quality were checked before writes.
- After maintenance, health, integrity, stats, and embeddings are coherent.
- After a substantive reply, a save-result was written.
