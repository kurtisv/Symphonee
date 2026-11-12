---
name: Investigate before implementing
description: Engineered, not rushed -- profile and understand the system before changing it, find root cause not symptoms, then implement deliberately. Use for any non-trivial fix or feature where the right design is not obvious.
when: a non-trivial bug, performance issue, or feature where you do not yet know the root cause or the right design
tags: workflow, core, quality
---

# Investigate before implementing

Symphonee work is "engineered not rushed, planned not on-the-go, and documented".
This skill is how you earn that: understand first, change second.

## Use when
- A bug whose cause is not yet known, or a "it feels slow / it flickers" report.
- A feature where the architecture or the right insertion point is unclear.
- Anything you would otherwise be tempted to fix by guessing.

## Do not use when
- The fix is obvious and localized (a typo, a known one-liner) -- just do it.
- The user explicitly asked for a quick patch and accepted the trade-off.

## Steps (primary path)
1. Reproduce / locate: find the exact files and lines involved before theorizing.
   Prefer the dedicated search tools over shelling out.
2. Find the ROOT cause, not the symptom. Trace the data/control flow to where the
   problem originates (e.g. a release that fires before the work it gates, a
   wrapper object stringified instead of its `.text`). Symptoms lie; flows do not.
3. Check what already exists: Mind (`/api/mind/query` for structure,
   `/api/mind/recall` for prior work), the relevant skills, plugins, and existing
   helpers. Do not re-solve what is already solved.
4. If the failure only happens on hardware or an environment you cannot run
   (a device, an OS version, a user account), INSTRUMENT before fixing: ship a
   diagnostic that reports the exact identity of what fails (component name,
   type, frame, children, versions) through a channel you can read (error
   tracker, device log). An opaque identifier (a numeric view tag, a bare id)
   is not an identity -- it tells you that something is wrong, not what.
5. Compare the observed identity with the public issue trackers of the libraries
   involved, pinned to the exact versions in use, before writing your own fix.
6. Decide the design deliberately. If there are real trade-offs the user owns,
   surface them; otherwise pick the obvious option and say which.
7. Only now implement -- via the `ship-a-change` skill.

## Safety
- Do not change behavior you do not understand; if a finding contradicts how
  something was described, surface it instead of plowing ahead.
- Measure before optimizing -- profiling beats guessing.
- Do not ship a build or release that only tests a hypothesis when one more
  measurement could name the cause: each guess costs a full build/test cycle and
  user time. Read all evidence you already hold before the next guess.
- A diagnostic must never change user-visible behavior, must be capped (rate
  limit, PII masking) and removable before production.

## Verification
- You can state the root cause in one sentence and point to the file:line, or
  to the measured component and the matching upstream issue.
- The fix addresses that cause, not a downstream symptom.
- Before/after on the real environment shows the behavior restored.
- You checked Mind/skills/plugins so you did not duplicate existing work.
