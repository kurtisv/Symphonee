# Symphonee Dashboard -- Redesign Strategy

Companion to `docs/ui-ux-audit-2026-07.md` (the findings) and
`DESIGN_SYSTEM.md` (the canonical reference). This is the "how we actually
get there" plan -- concrete, sequenced, and scoped to avoid the two failure
modes the original brief explicitly warned against: a disorganized
big-bang rewrite, and silent scope creep into files nobody asked to touch.

## Guiding constraints (non-negotiable)

- No functionality regressions. Every fix below is additive (new attributes,
  new classes on new elements) or a scoped migration of ONE call site,
  individually verified.
- No silent deletions. If a legacy class/pattern is superseded, it stays in
  `styles/app.css` until every consumer has migrated -- removing it early
  breaks whatever hasn't moved yet.
- No framework introduction. Vanilla HTML/CSS/JS stays vanilla.
- No unrequested libraries. Every tool in `skills/figma-to-code-handoff`'s
  list is opt-in and verified against official docs before use, not assumed.
- Each cleanup pass (button migration, empty-state migration, card migration,
  focus-trap rollout) is its OWN change, reviewed on its own diff -- never
  bundled invisibly into an unrelated feature fix.

## Component structure

No change to the underlying architecture (per-feature `src/index.js` bundles,
flat/IIFE global-scope mix, `innerHTML`-template rendering). That architecture
is a deliberate fit for this app's size and team, not a gap. The one
structural improvement worth pursuing opportunistically: when a second or
third panel needs the same list/render/form-assembly logic, extract it into
`util/src/index.js` (today it only holds `escapeHtml()`) -- but only when a
real second consumer appears, not preemptively.

## Design system application

`DESIGN_SYSTEM.md` is now the enforcement reference, checked by
`design-system-guardian` (every new UI change) and `dashboard-ui-reviewer`
(every panel-level review). The rollout order for existing debt:
1. Stop the bleeding: no NEW `.btn`/`.modal-btn`/bespoke-card/`.empty-state`
   usage from this point forward (enforced by the skill, not by a mass edit).
2. Migrate opportunistically: any time an existing panel is touched for an
   unrelated reason, and the touched element uses a legacy pattern, migrate
   that specific element as part of the change (small, in-context, easy to
   review) -- don't go looking for other instances to fix in the same diff.
3. Dedicated passes for anything that won't naturally get touched otherwise
   (see the audit's P1/P2 priority list) -- scheduled separately, not implied
   by this document.

## Modal rework (first correction, already applied)

`settingsModal` now has `role="dialog"`, `aria-modal="true"`,
`aria-labelledby="settingsModalTitle"`, a working Tab focus-trap, and
focus save/restore on open/close -- covering the explicit close button,
Escape, and click-outside-backdrop paths (via a new small `data-close-fn`
convention on `.modal-overlay`, added to `keyboard.js`'s existing
Escape/overlay-click handlers, which fall back to the exact previous
behavior for the other 15 modals that don't set it). See:
- `dashboard/public/index.html` (`settingsModal` attributes)
- `dashboard/public/settings/src/index.js` (`_settingsFocusTrap`,
  `_settingsFocusReturnEl`, wired into `openSettings`/`closeSettings`)
- `dashboard/public/app/src/shell/keyboard.js` (`closeModalOverlay` helper)

**Deliberately NOT done in this same change:** migrating `settingsModal`'s
~15 internal `.modal-btn` buttons (Cancel/Save, Add Project, Add Space,
Browse Local, Add Server, New/Save Theme, Export/Import Themes, etc.) to
`.sy-btn`. That's a real, larger surface with inline style overrides on
several buttons -- exactly the kind of change `design-system-guardian`
says not to bundle into an unrelated fix. It's next in the queue as its
own reviewed change.

**Next in the modal rollout, in order:** `createModal` (work item creation,
second-most-used) -> `confirmDialog`/`promptDialog` (used everywhere, small
and low-risk) -> the remaining 12, each as its own change using
`settingsModal`'s implementation as the template.

## Form rework

Apply `modal-and-form-polisher`'s checklist (label/aria-describedby on every
field, inline validation next to the field, `toast()` for whole-form
failures) the next time any settings/modal form is touched. The concrete,
already-identified first target: the `mcpNewEnv` textarea
(`index.html:1584`) that currently duplicates `.modal-field` styling inline
instead of using the class -- fix it the next time that panel is touched,
not as a standalone drive-by edit disconnected from other work in that area.

## Sidebar / navigation

No structural change recommended. The sidebar/intel rail layout
(`--sidebar-w`/`--intel-w`, both 300px) and the ARIA-tabs-wired tab bar are
both working correctly and shouldn't be touched without a specific reason.
If a future feature needs a new top-level nav affordance, prefer a real
`<nav>` landmark over another `role="navigation"`-on-a-div, matching the
existing gap noted in the audit (no real `<nav>`/`<main>`/`<footer>`
anywhere) -- but retrofitting the EXISTING `role="main"` div to a real
`<main>` is a separate, deliberate change (verify no CSS/JS selects on the
div specifically) and not bundled here.

## Tables

No change recommended. The one real `<table>` (`.backlog-table`) is correctly
scoped to genuinely tabular data; everything else is correctly NOT a table.
Don't force new tabular-looking UI into `<table>` markup, and don't convert
`.backlog-table` to divs -- both would be solving problems that don't exist.

## Empty states

Adopt `.sy-empty` for any NEW empty state starting now (see
`DESIGN_SYSTEM.md`). Migrating the 80 existing `.empty-state` call sites is
a dedicated pass, sequenced after the modal rollout (P1, not P0) since it's
lower-risk (visual only, no focus/keyboard implications) but higher-volume.
Do it panel-by-panel, verifying each with `visual-qa-before-commit`.

## Loading states

No new pattern needed -- `.spinner` for in-panel, `.loading-overlay` for
boot/splash only, is already correct and sufficient. The only fix is
separating loading from empty (see above) so they're not sharing one
ambiguous `.empty-state` div going forward.

## Error messages

Add a `.sy-empty` destructive variant (or a small dedicated `.sy-error`
class following the same icon+title+desc+actions shape, using `--red`/
`--sy-badge-destructive`'s color-mix pattern) for persistent in-panel errors,
reserving `toast(msg, 'error')` for transient action-result feedback as it
already correctly is. This is a small, contained `styles/app.css` addition
plus a `DESIGN_SYSTEM.md` update -- propose it as its own change before any
panel starts consuming it, so the pattern is settled once, not invented
per-panel.

## Responsive (window/panel resize, not mobile)

No mobile work -- see `skills/mobile-ui-safe-area-review` for why that's
correct, not a gap. The only responsive work in scope: apply the existing
`max-width: 900px` rail-collapse pattern (currently only on the Mind panel)
to any NEW rail-plus-detail layout that could be squeezed narrow, using the
same breakpoint unless a specific layout needs a different one.

## Accessibility

Sequenced after the modal-dialog rollout (which IS the top a11y priority):
icon-only button labeling (audit each panel as it's touched, don't do a
blanket sweep that risks mislabeling something you don't understand), then
tightening the 46 inconsistent individual `:focus` rules to a consistent
visible ring, panel by panel.

## Summary: what's actually done vs. queued

**Done in this pass:** `DESIGN_SYSTEM.md`, 8 enforcement skills, the full
audit, this strategy doc, and the `settingsModal` dialog-semantics/focus-trap
fix (built and syntax-checked; **not yet interactively verified in the live
running app** -- see the note below).

**Queued, in priority order:** `.sy-btn` migration inside `settingsModal`'s
footer/action buttons -> `createModal`/`confirmDialog`/`promptDialog` dialog
semantics -> remaining 12 modals -> icon-button `aria-label` audit ->
`.empty-state` -> `.sy-empty` migration -> bespoke-card -> `.sy-card`
migration -> new error-state class -> focus-ring consistency pass.

## Important caveat on the applied fix

Per `visual-qa-before-commit`'s own safety rule: the `settingsModal` change
was verified with a clean renderer rebuild and `node --check` on every
touched source and generated file, but **has not been interactively
exercised in the live running Electron app** in this session -- reloading
and clicking through the actual currently-running Symphonee window (the one
this conversation is happening through) was judged too risky to automate
mid-session. Please reload (Ctrl+R) and manually verify: open Settings, Tab
through the fields (should stay trapped inside the modal), Shift+Tab from
the first field (should wrap to the last), Escape (should close AND return
focus to whatever had focus before), and click the backdrop outside the
modal (same). If anything's off, the change is small and easy to revert or
adjust.
