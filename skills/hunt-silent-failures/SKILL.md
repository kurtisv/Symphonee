---
name: Hunt silent failures
description: Find code paths that fail with no visible outcome: swallowed errors, empty fallbacks, state set to something nothing can render, actions that silently do nothing. Use after a "nothing happens" or "blank screen" bug, and when reviewing error handling.
when: a bug where the UI goes blank or an action does nothing without an error, or a review of error handling and fallbacks
tags: quality, debugging, review
---

# Hunt silent failures

A silent failure is worse than a crash: nothing reports it, so it survives tests,
monitoring and review. This skill finds the whole class, not only one instance.

## Use when
- A user reports "nothing happens", "the screen goes empty", "buttons disappear",
  and no error reaches the logs or the error tracker.
- You just fixed one silent failure: sweep for siblings of the same shape.
- Reviewing error handling, fallbacks, or async flows before shipping.

## Do not use when
- The failure is loud (exception, crash report) -- debug it directly.
- Pure styling or copy changes.

## Steps (primary path)
1. Name the shape of the failure as a one-line pattern, for example: "a selection
   id is set, but the component that should display it resolves only from a
   local list that may not contain it".
2. Enumerate EVERY entry point that can produce that state (all setters,
   dispatchers, deep links, notifications, voice or remote commands, URL params).
   List them with file:line before judging any of them.
3. For each entry point, answer: can it produce a state nothing renders? does it
   hide controls while showing nothing? does it return early with only a debug log?
4. Also hunt the generic markers in the touched area:
   - empty catch blocks, or errors converted to null/[] with no log or message;
   - catch-to-empty fallbacks that hide a real failure;
   - async calls whose rejection is never handled or never awaited;
   - effects that re-fire on data refresh and redo a one-shot action;
   - network/db calls without timeout or error path.
5. Fix the root shape once where possible (a shared resolver or fallback), then
   add a safety net at the rendering boundary: if a state cannot be displayed,
   reset it instead of leaving an empty screen.
6. Add one regression test per entry point that reproduces the state, red before
   the fix and green after.

## Safety
- A safety net must not mask the root cause: fix the producers first and keep the
  net as the last line.
- Never replace a silent failure with another silent fallback; the user must see
  content or a message, or the state must be reset.
- Do not widen catch blocks to hide the symptom.

## Verification
- Every enumerated entry point is fixed, proven safe, or listed as open.
- Regression tests fail on the old code and pass on the new one.
- The original user scenario is reproduced on a real device or environment after
  the fix, not only in unit tests.
