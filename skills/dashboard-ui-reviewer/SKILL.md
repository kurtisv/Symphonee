---
name: Dashboard UI reviewer
description: Audit Symphonee's dashboard panels (tables, filters, stat cards, sidebars, menus, forms) for consistency with the actual patterns already in use, and catch the specific known inconsistencies (3 button systems, 2 empty-state patterns, unused .sy-card/.sy-empty) before they get worse.
when: reviewing or building any dashboard panel -- backlog/work-items, PRs, notes, settings, plugins, files, activity, or a new panel
tags: ui, review, dashboard, audit
---

# Dashboard UI reviewer

`dashboard/public/` has ~30 feature panels (backlog/work-items, PRs, notes,
settings, plugins, files, git, activity, browser, apps-tab, command-palette,
and more), each with its own `src/index.js` and no shared component
framework. This skill is the review pass for panel-level UI: does this panel
look and behave like the others, or does it quietly diverge.

## Use when
- Adding a new panel/tab to the dashboard.
- Reviewing a change to an existing panel (settings, work-items, PRs, notes,
  files, plugins, etc.).
- The user asks "does this look consistent with the rest of the dashboard".

## Do not use when
- The change is purely backend/IPC/orchestrator logic with no rendered panel.
- Reviewing a one-off internal tool or script with no dashboard surface.

## Steps (primary path)
1. Identify what kind of content the panel renders and check it against the
   real conventions, not assumptions:
   - Genuinely tabular data (fixed columns, sortable, dense) -> a real
     `<table>` like `.backlog-table` (the only one that exists today).
   - A list of variable-height items (PRs, notes, comments, notifications) ->
     stacked `<div>` rows, NOT a table -- this is correct, not a gap.
2. Check for the three-button-system trap: does the panel use `.sy-btn`
   (canonical), or does it add another `.btn-*`/`.modal-btn-*` usage? Flag any
   new non-`.sy-btn` button.
3. Check empty/loading/error handling: is a genuine "no data" state using
   `.sy-empty` (icon + title + description + actions), not the legacy
   `.empty-state` div that conflates loading and empty? Is a real loading
   state just `.spinner` + text, not dressed up as `.empty-state`?
4. Check for reinvented rendering: does this panel's `render*()` duplicate
   logic that already exists in another panel (list rendering, filter
   controls, pagination)? If two panels need the same list-rendering
   behavior, that's a candidate to extract into `util/src/index.js` (today it
   only holds `escapeHtml()`) -- flag it, don't silently duplicate a third
   time.
5. Check sidebar/filter/menu controls use `.field-*` (outside modals) or
   `.modal-field` (inside modals) consistently -- not ad hoc inline-styled
   inputs.
6. Check stat/summary cards use `.sy-card`, not a bespoke surface + border +
   radius combination.
7. Cross-reference `DESIGN_SYSTEM.md` for anything this list doesn't cover.

## Safety
- Flag inconsistencies; don't silently mass-fix unrelated panels while
  reviewing one. Note them for a dedicated cleanup pass instead.
- Don't recommend a component framework or templating library to solve
  duplication -- extracting a plain shared helper function into
  `util/src/index.js` is the right scale of fix for this codebase.

## Verification
- The panel's buttons, badges, cards, and empty/loading states match
  `DESIGN_SYSTEM.md`'s canonical choices.
- Any genuinely new shared-behavior candidate is called out explicitly rather
  than quietly duplicated.
- The panel was exercised live (reload, trigger empty state, trigger loading,
  trigger an error) per `visual-qa-before-commit`.
