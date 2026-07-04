---
name: Design system guardian
description: Enforce Symphonee dashboard's color tokens, typography, spacing, radius, buttons, cards, inputs, and modal conventions from DESIGN_SYSTEM.md on every new piece of UI -- and stop new bespoke reimplementations of things that already have a canonical class.
when: writing or editing any HTML/CSS in dashboard/public, or any innerHTML template in app/src/shell/*.js, mind-ui/src/*.js, or <feature>/src/index.js
tags: ui, design-system, css, dashboard, core
---

# Design system guardian

Symphonee's dashboard (`dashboard/public/`) has a real, semantic, six-theme
design-token system in `styles/app.css` and a canonical component layer
(`.sy-btn`, `.sy-badge`, `.sy-card`, `.sy-empty`) that is under-adopted. The
job of this skill is to make sure new UI uses what already exists instead of
inventing a 4th button system or a 2nd color palette. Full detail lives in
`DESIGN_SYSTEM.md` at the repo root -- read it once, then use this skill as
the enforcement checklist on every change.

## Use when
- Writing any new CSS rule in `dashboard/public/styles/app.css`.
- Writing any new `innerHTML` template string, `document.createElement` call,
  or modal markup anywhere under `dashboard/public/`.
- Reviewing someone else's UI change before it ships.

## Do not use when
- The change is pure logic with no rendered markup or style (e.g. state
  management, IPC wiring, non-UI utility functions).
- Editing a generated `js/*.js` file directly -- that's always wrong regardless
  of this skill; see `verify-frontend-edit`.

## Steps (primary path)
1. Colors: never hardcode a hex value. Use the semantic role variables
   (`--crust`, `--mantle`, `--base`, `--surface0/1/2`, `--overlay0/1`,
   `--subtext0/1`, `--text`, `--blue/sapphire/green/yellow/peach/red/mauve/teal`,
   `--accent`). If you need a new color relationship, use `color-mix(in srgb,
   var(--X) N%, var(--Y))` the way `.sy-badge-success`/`.sy-card-interactive`
   already do -- don't add a 7th raw hex constant.
2. Structural tokens: use `--radius` (6px, small controls), `--radius-lg`
   (10px, buttons/cards/panels), `--radius-xl` (14px, modals/large surfaces),
   `--radius-pill` (badges/switches). Don't invent a new radius value.
3. Spacing: there is no numeric spacing scale yet. Match the padding/gap
   values already used in the surrounding component family (4/6/8/10/12/14/
   16/20px are the values in active use) rather than picking an arbitrary
   number. Do not add a `--space-*` scale as a side effect of an unrelated
   change -- that's a Design System doc change of its own.
4. Buttons: use `.sy-btn` + a variant (`-outline`/`-ghost`/`-secondary`/
   `-destructive`/`-link`) + a size (`-sm`/default/`-lg`/`-icon`) for ALL new
   buttons, including inside modals. Never add a new `.btn-*` or `.modal-btn-*`
   class. Icon-only buttons must be `.sy-btn-icon` AND carry `aria-label`.
5. Badges/status pills: use `.sy-badge` + the semantic variant matching the
   status (`-success`/`-warning`/`-destructive`/`-outline`/`-secondary`/
   `-muted`). Don't hand-roll a colored pill.
6. Cards: use `.sy-card`/`.sy-card-header`/`.sy-card-title`/`.sy-card-desc`/
   `.sy-card-content`/`.sy-card-footer` for any new card-like surface. Don't
   reimplement the surface/border/radius look by hand the way `.wi-comment`/
   `.repo-sidebar-item`/`.apps-viewport-tile` currently do (those are known
   legacy debt, not a pattern to copy).
7. Forms: use `.field-label`/`.field-select`/`.field-input`/`.field-group`
   outside modals, `.modal-field` inside modals. Never inline-style a form
   control that duplicates one of these classes.
8. Empty/loading/error: use `.sy-empty` (+ `-icon`/`-title`/`-desc`/`-actions`)
   for genuine empty states; `.spinner` alone (no empty-state wrapper) for
   in-progress loading; `toast()`/`richToast()` for transient
   success/error/warning/info feedback. Don't reuse `.empty-state` for new
   code -- it's legacy and conflates loading with empty.
9. If what you need genuinely doesn't exist yet (a new badge variant, a new
   card layout), add it as an extension of the `.sy-*` family in the same
   section of `styles/app.css`, and document it in `DESIGN_SYSTEM.md` in the
   same change -- don't leave the doc stale.

## Safety
- Do not mass-migrate existing `.btn`/`.modal-btn`/`.empty-state`/bespoke-card
  call sites as a side effect of an unrelated task. Each is a deliberate,
  reviewed cleanup pass (see the UI/UX audit's priority list) -- silently
  "fixing" them inflates an unrelated diff and risks regressions in code you
  weren't asked to touch.
- Never hardcode a color, radius, or font that already has a token -- that's
  exactly how the app ended up with 3 button systems in the first place.
- Don't introduce a UI framework (React/Vue/Tailwind) to make this easier.
  The vanilla stack is deliberate.

## Verification
- `grep` the diff for raw hex colors (`#[0-9a-fA-F]{3,6}`) outside the theme
  blocks in `styles/app.css` -- there should be none in feature-level CSS.
- New buttons are `.sy-btn`-based; new cards are `.sy-card`-based; new badges
  are `.sy-badge`-based.
- `DESIGN_SYSTEM.md` still accurately describes the change (updated if a new
  token/variant was added).
- The change was verified live per `verify-frontend-edit` (rebuild renderer,
  reload, exercise the touched UI in both a dark and a light theme).
