# Symphonee Dashboard UI/UX Audit -- 2026-07

Scope: `dashboard/public/` (the Electron renderer -- vanilla HTML/CSS/JS, no
framework). Based on a full-codebase survey, not sampling. Companion
documents: `DESIGN_SYSTEM.md` (the canonical reference this audit's fixes
point at) and `skills/*/SKILL.md` (the enforcement mechanism going forward).

## How to read this

Each finding lists: what's wrong, why it matters, exactly which files/lines
are affected, and where it sits in the priority plan at the bottom. This is
not a rewrite mandate -- most of the underlying system (theming, tokens,
toast, ARIA-tabs) is genuinely solid. The problems are consistency and
completion, not foundation.

## UI problems

### P0 -- Three parallel button systems coexist
`.btn`/`.btn-primary`/`.btn-sm` (legacy, `styles/app.css:398-416`),
`.modal-btn`/`.modal-btn-primary` (legacy, modal-only, `styles/app.css:
4235-4242`), and `.sy-btn` + variants (canonical, `styles/app.css:24-102`).
The canonical layer is used in only 3 of ~30 source files
(`app-state.js`, `apps-tab/src/index.js`, `spaces-repos/src/index.js`).
Every new button risks picking the wrong one by copy-paste precedent.
**Files affected:** all ~30 feature panels; heaviest concentration in modal
footers (13+ `.modal-overlay` blocks).

### P0 -- `.sy-card` and `.sy-badge` are fully built but completely unused
Defined and styled (`styles/app.css:104-140`), zero usages in any JS or HTML.
Meanwhile bespoke card-look-alikes (`.wi-comment`, `.repo-sidebar-item`,
`.apps-viewport-tile`) each hand-roll the same surface/border/radius look.
A ready-made consolidation is sitting unused while duplication continues.

### P1 -- Two non-interoperable form-field conventions, plus inline duplicates
`.field-label`/`.field-select`/`.field-input`/`.field-group` (sidebar/settings)
vs. `.modal-field` (modals), `styles/app.css:386-395` and `:4225-4233`. At
least one field (`mcpNewEnv` textarea, `index.html:1584`) duplicates
`.modal-field` styling entirely inline instead of using the class -- a sign
the two-convention split itself invites this kind of drift.

### P1 -- Two competing, overlapping empty/loading-state patterns
`.empty-state`/`.empty-state-text` (legacy, used 80+ times across 9 files,
doubles as both "loading" and "genuinely empty" depending on inline text/
`.spinner` presence) vs. `.sy-empty` (better-designed icon+title+desc+actions
hero, zero adoption). The legacy pattern's loading/empty ambiguity is a real
UX defect independent of the design-system inconsistency: a user can't tell
at a glance whether a panel is still loading or genuinely has nothing.

### P2 -- No dedicated error-state class
Errors surface either as an inline `color:var(--red)` tacked onto
`.empty-state-text`, or via `toast()`. There's no persistent in-panel error
pattern (e.g. "failed to load PRs, retry?") distinct from a transient toast.

### P2 -- No shared render/list/form-builder helper beyond `escapeHtml()`
`util/src/index.js` (21 lines) holds exactly one shared cross-cutting
utility. Every panel (`settings/src/index.js` 1,004 lines, `work-items/src/
index.js` 1,886 lines, `pull-requests/src/index.js` 484 lines, `notes/src/
index.js` 765 lines, `plugins/src/index.js` 1,422 lines) reimplements its own
`render*()` and list/form assembly from scratch. Not urgent to fix wholesale,
but a real source of drift risk every time one of these five panels changes
independently.

## UX problems

### P0 -- All 16 modal dialogs lack dialog semantics
13 `.modal-overlay` blocks (`createModal`, `appsInstructionsModal`,
`appsAutomationsModal`, `factoryResetModal`, `settingsModal`, `registryModal`,
`spaceModal`, `repoModal`, `branchModal`, `gitModal`, `confirmDialog`,
`promptDialog`, `browserAgentDetailModal`) plus 3 `.pr-comment-modal`-classed
dialogs (`prCommentModal`, `wiCommentModal`, `prRequestChangesModal`) --
**none** have `role="dialog"`, `aria-modal="true"`, or a documented focus
trap. This is both an accessibility and a UX defect: keyboard/screen-reader
users can't reliably tell a modal is modal, or that focus should stay inside
it.

### P1 -- Icon-only buttons are mostly unlabeled
Only 9 `aria-label` attributes exist in `index.html` against many more
icon-only buttons defined in CSS (sidebar collapse rails, panel action
buttons, etc.). Screen-reader users hit unnamed controls.

## Design inconsistencies

Summarized from the sections above, ranked by how much they compound over
time if left unaddressed:
1. Three button systems (P0) -- every new feature is a coin-flip on which one
   gets copied.
2. Two empty-state systems, one of them conflating loading/empty (P1).
3. Two form-field systems plus ad hoc inline duplicates (P1).
4. Unused `.sy-card`/`.sy-badge` alongside continued bespoke card patterns (P0).

## Responsive-design finding (reframed, not a gap)

No `<meta name="viewport">`, no `safe-area-inset-*` anywhere -- confirmed
deliberate: this is a desktop-only Electron shell with no phone/tablet
target. The 4 existing `@media` blocks handle in-app window/panel resizing
(`max-height: 720px/560px` for the Apps viewport, `max-width: 900px` for the
Mind panel's rail collapse) and `prefers-reduced-motion`, not device classes.
**Do not read "no mobile support" as a gap to close** -- see
`skills/mobile-ui-safe-area-review/SKILL.md`, which was deliberately reframed
around window/panel resizing instead of phone/tablet handling for this exact
reason.

## Accessibility problems

- **P0**: all 16 modals lack `role="dialog"`/`aria-modal`/focus-trap (see UX
  P0 above -- it's both a UX and an a11y defect).
- **P1**: icon-only buttons mostly unlabeled (9 `aria-label` vs. many more
  icon buttons in CSS).
- **P2**: 46 individual `:focus`/`outline` CSS rules exist across the file;
  some set only a `border-color` change on focus rather than a visible ring,
  relying on the global `:focus-visible` fallback rather than an explicit,
  generous indicator. Inconsistent, not absent.
- **Working well, build on this, don't rebuild it**: the main tab bar has
  fully correct ARIA-tabs wiring (`role="tablist"/"tab"/"tabpanel"`,
  cross-referenced `aria-controls`/`aria-labelledby`/`aria-selected`); a
  dedicated a11y CSS block exists (global focus-visible fallback, working
  `.skip-link`, `.sr-only`, `prefers-reduced-motion` neutralization); a live
  region (`#a11yLive`) exists for screen-reader announcements.

## Components to rework (priority order within each tier)

**P0 (do these first -- highest risk/impact, most contained blast radius):**
1. Add `role="dialog"`/`aria-modal`/`aria-labelledby`/focus-trap to modals --
   start with `settingsModal` (largest, most-used) as the reference
   implementation, then roll the pattern to the other 15 incrementally as
   each is touched (not all at once).
2. Adopt `.sy-btn` as the only button class for any modal footer touched
   going forward (stop growing `.modal-btn` usage).

**P1 (next -- meaningful UX/consistency wins, moderate effort):**
3. Introduce a `.sy-empty`-based error variant (or a small new `.sy-error`
   class) to replace ad hoc inline-red error text; migrate incrementally.
4. Start adopting `.sy-card` for any *new* card-like surface; do not mass-
   migrate `.wi-comment`/`.repo-sidebar-item`/`.apps-viewport-tile` in one
   pass -- each has its own layout needs to verify individually.
5. Add `aria-label` to icon-only buttons as each panel is touched.

**P2 (opportunistic -- do when touching the relevant file anyway):**
6. Extract shared list/render helpers into `util/src/index.js` when a second
   or third panel needs the same behavior -- don't force this preemptively.
7. Consolidate `.field-*` vs `.modal-field` usage; fix the known
   `mcpNewEnv` inline-style duplicate as a concrete first instance.
8. Tighten inconsistent `:focus` rules to a visible ring across the board.

## Step-by-step action plan

1. **Now:** `DESIGN_SYSTEM.md` and the 8 skills (this audit's companion
   deliverables) are live -- every new UI change is reviewed against them
   going forward via `design-system-guardian`/`dashboard-ui-reviewer`.
2. **Next PR touching any modal:** apply the dialog-semantics fix (P0 #1)
   to that modal specifically, using `settingsModal` as the reference once
   it's done first.
3. **Ongoing -- any new button/card/empty-state:** must be `.sy-btn`/`.sy-card`/
   `.sy-empty` -- enforced by `design-system-guardian`, verified by
   `dashboard-ui-reviewer`.
4. **Dedicated cleanup pass (not bundled with feature work):** migrate
   remaining `.btn`/`.modal-btn` call sites, `.empty-state` call sites, and
   bespoke card look-alikes to the canonical layer, one panel at a time,
   each independently verified via `visual-qa-before-commit`.
5. **Dedicated a11y pass:** roll `role="dialog"` etc. to the remaining 15
   modals; audit and label the icon-only buttons across all ~30 panels;
   tighten the 46 inconsistent focus rules.

No functionality changes anywhere in this plan -- every item is additive
(new class usage, new ARIA attributes) or a scoped, individually-verified
migration of one call site at a time.
