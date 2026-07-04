# Symphonee Dashboard Design System

This is the canonical UI reference for `dashboard/public/` — Symphonee's Electron
renderer. It documents what already exists in `styles/app.css` (5,312 lines,
`dashboard/public/styles/app.css`) and `index.html`, resolves the inconsistencies
found by the initial audit (see `docs/ui-ux-audit-2026-07.md`), and states which
pattern is canonical going forward. This is a **consolidation document**, not a
replacement — the renderer has a real, semantic, six-theme design-token system
already. Nobody should introduce a UI framework (React, Vue, Tailwind) to satisfy
this doc; the stack stays vanilla HTML/CSS/JS by design (see
`skills/verify-frontend-edit/SKILL.md` for why).

## Stack reality (read this before anything else)

- No component framework. UI is built with template-literal strings assigned to
  `.innerHTML`, plus `document.createElement` for a handful of dynamically
  attributed nodes (select options, download links). This is intentional, not
  a gap to "fix" by adopting React.
- `js/app.js` and `mind-ui.js` (and every other `js/<feature>.js`) are
  **generated**. Always edit the source (`app/src/shell/*.js`,
  `mind-ui/src/*.js`, `<feature>/src/index.js`) and rebuild — never hand-edit
  a `js/*.js` output file.
- Desktop-only Electron shell. No `<meta name="viewport">`, no
  `safe-area-inset-*` anywhere, and that is correct — do not add mobile
  breakpoints or safe-area handling; there is no phone/tablet target. The four
  existing `@media` blocks handle in-app window/panel resizing and
  `prefers-reduced-motion`, not device classes.

## Color tokens

Six themes, each a full `[data-theme="..."]` block on `<html>` defining the
same Catppuccin-style semantic role names. Never hardcode a hex value in new
CSS — always reference the role:

```
--crust, --mantle, --base                    surface depth, darkest to lightest (dark themes; inverted in light themes)
--surface0, --surface1, --surface2           raised surfaces (cards, inputs, hover states)
--overlay0, --overlay1                       borders, dividers, subtle UI chrome
--subtext0, --subtext1, --text               body text, low to high emphasis
--blue, --sapphire, --green, --yellow,
--peach, --red, --mauve, --teal              semantic/status colors
--accent                                     the theme's primary action color (maps to one of the above per theme)
```

Themes: `industrial-blue` (default, dark, `--accent:#078efa`), `warm-metallic`
(dark), `futuristic-green` (dark, `--accent:#10a37f`), `arctic-frost` (light,
`--accent:#2563eb`), `warm-sand` (light, `--accent:#c2703e`), `custom`
(user-authored via the in-app theme editor, `themes/src/index.js`, values
injected inline — never assume a `custom` theme has any specific hex value).

Switching mechanism: set `data-theme` on `<html>`, applied by an inline
pre-CSS script in `index.html` (before the stylesheet loads) to avoid a
flash of the wrong theme. Any new themed surface must consume the existing
role variables — do not invent a parallel color system.

## Structural tokens

```
--font-ui:   'Segoe UI', -apple-system, sans-serif
--font-mono: 'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace
--radius:      6px   (small controls, inputs)
--radius-lg:  10px   (buttons, cards, panels)
--radius-xl:  14px   (large surfaces, modals)
--radius-pill: 999px (badges, pills, switches)
--sidebar-w: 300px   --intel-w: 300px   --header-h: 46px   --term-bar-h: 40px
```

**No spacing scale exists.** Spacing is ad hoc pixel values per rule (`padding:
14px 16px 10px`, `gap: 6px`, etc.), not tokenized. Until a real scale is
introduced, match the surrounding rule's spacing rather than inventing a new
number — 4px, 6px, 8px, 10px, 12px, 14px, 16px, 20px are the values already in
common use across `.sy-*`, `.modal-*`, and panel CSS. Do not add a `--space-*`
scale piecemeal in one file; that's a Design System doc change with its own
review, not a drive-by addition inside a feature fix.

## Buttons — `.sy-btn` is canonical for all new UI

Three button systems exist. Only one is canonical going forward:

| System | Status | Where it's used |
|---|---|---|
| `.sy-btn` + variants (`-outline`, `-ghost`, `-secondary`, `-destructive`, `-link`) + sizes (`-sm`, default, `-lg`, `-icon`) | **Canonical. Use this for all new buttons.** | `styles/app.css:24-102`. Currently consumed by only 3 source files (`app-state.js`, `apps-tab/src/index.js`, `spaces-repos/src/index.js`) plus `index.html` — this is the adoption gap, not a reason to avoid it. |
| `.btn` / `.btn-primary` / `.btn-sm` | Legacy. Do not use in new code. Do not mass-migrate without a dedicated pass (see audit). | Sidebar/list-item buttons across most panels. |
| `.modal-btn` / `.modal-btn-primary` | Legacy, modal-specific. Do not use in new code — use `.sy-btn` inside modals too. | Nearly every modal footer (`styles/app.css:4235-4242`). |

`.sy-btn` already has: theme-aware focus-visible ring (`--sy-ring` /
`--sy-ring-offset`, respects the active theme's accent), disabled state via
`:disabled`/`[aria-disabled="true"]`, and icon sizing (`.sy-btn svg`/`i`
auto-sized to 14px). Use `.sy-btn-icon` for icon-only buttons and always pair
it with `aria-label` (see Accessibility below — icon-only buttons are the
single biggest a11y gap in the app today).

## Badges — `.sy-badge`

Canonical, actively usable now (no legacy competitor). Variants: default
(solid accent), `-outline`, `-secondary`, `-success`, `-warning`,
`-destructive`, `-muted`. Use the semantic variant that matches the status
being conveyed (`-success`/`-warning`/`-destructive`), not a raw color.

## Cards — `.sy-card` (defined, currently unused — start adopting it)

`.sy-card` / `.sy-card-header` / `.sy-card-title` / `.sy-card-desc` /
`.sy-card-content` / `.sy-card-footer` (+ `.sy-card-interactive` for
clickable cards with hover lift) are fully styled in `styles/app.css:120-140`
but have **zero usages** in any JS or HTML today. Every "card-like" surface in
the app (`.wi-comment`, `.repo-sidebar-item`, `.apps-viewport-tile`, hero
cards) currently reimplements the same surface/border/radius look by hand.
**New card-like UI must use `.sy-card`, not a bespoke reimplementation.**
Migrating the existing bespoke ones is a separate, deliberate cleanup pass —
see `docs/ui-ux-audit-2026-07.md` priorities — not something to do silently
inside an unrelated change.

## Forms

Two non-interoperable conventions exist:
- `.field-label` / `.field-select` / `.field-input` / `.field-group`
  (sidebar/settings context, `styles/app.css:386-395`).
- `.modal-field` (styles raw `input`/`select`/`textarea` inside any modal,
  `styles/app.css:4225-4233`).

Use whichever convention matches the surface you're in (sidebar/settings vs.
modal) — do not invent a third. Never hand-roll inline styles that duplicate
one of these classes (e.g. the `mcpNewEnv` textarea in `index.html:1584`
currently does this — a concrete cleanup target, not a pattern to repeat).
Every new form field needs a real `<label for="...">` or `aria-label`; never
placeholder-only.

## Tables and lists

Only one real `<table>` exists in the entire app: `.backlog-table` (work
items list, sticky header, parent/child rows, `.state-badge`/`.priority-N`
cell classes). Every other "list" (PRs, notes, notifications, activity feed,
work-item comments) is rendered as stacked `<div>` rows via the same
innerHTML-map-join pattern, not a real table — that's correct for
non-tabular, variable-height content; don't force a `<table>` onto it.

**Reuse gap:** beyond `escapeHtml()` (`util/src/index.js`, the one shared
cross-cutting helper, used across 9+ modules), there is no shared
render/list/form-builder utility. Every panel (`settings/src/index.js`,
`work-items/src/index.js`, `pull-requests/src/index.js`, `notes/src/index.js`,
`plugins/src/index.js`) reimplements its own `render*()` from scratch. New
list/card-grid UI should look for a chance to extract a shared helper into
`util/src/index.js` rather than adding a 6th bespoke implementation — but
don't force a refactor of the other 5 as a side effect of an unrelated task.

## Modals

16 modal dialogs exist (13 `.modal-overlay` blocks in `index.html` +
3 `.pr-comment-modal`-classed dialogs nested in the PR panel). **None of them
have `role="dialog"`, `aria-modal="true"`, or a documented focus-trap.** This
is the top-priority accessibility gap in the app (see audit). Every new modal
must have:
- `role="dialog"` and `aria-modal="true"` on the outer `.modal-overlay` (or
  equivalent) element.
- `aria-labelledby` pointing at the modal's visible title element.
- Focus moved into the modal on open and returned to the trigger on close.
- Escape-to-close and click-outside-to-close, matching existing modal
  behavior (verify against `settingsModal`, the largest and most complete
  existing modal, before diverging).
- Footer buttons built with `.sy-btn`, not `.modal-btn` (see Buttons above) —
  new modals should not perpetuate the legacy footer button class.

## Empty, loading, and error states

Two competing empty-state patterns exist:
- `.empty-state` / `.empty-state-text` (legacy, actively used in 80+ places
  across 9 files) — also doubles as the loading state, differentiated only by
  swapping in a nested `.spinner` and different text. This ambiguity (is it
  loading or genuinely empty?) is a real UX gap.
- `.sy-empty` / `.sy-empty-icon` / `.sy-empty-title` / `.sy-empty-desc` /
  `.sy-empty-actions` (defined in CSS, **zero JS usages** today) — a proper
  icon + title + description + actions empty-state hero.

**Going forward: use `.sy-empty` for genuine empty states** (no data, first
run, filtered-to-nothing) and reserve `.spinner` + a text label alone for
in-progress loading — don't conflate the two under one `.empty-state` div in
new code. Migrating the 80 existing `.empty-state` call sites is a dedicated
cleanup pass, not something to do opportunistically.

Loading: `.spinner` (small, inline rotating-border) for in-panel loading;
`.loading-overlay` (full-screen) only for app boot/splash — do not reuse
`.loading-overlay` for a panel-level loading state.

Errors: **no dedicated error-banner class exists.** Current practice is
either an inline `color:var(--red)` tacked onto the `.empty-state-text`, or
the shared `toast(msg, 'error')`. For a transient/actionable error, use
`toast()`/`richToast()` (see below). For a persistent in-panel error state
(e.g. "failed to load PRs"), a new `.sy-empty` variant with the destructive
icon color is preferable to another one-off inline style — raise this as a
design-system addition rather than inventing a 3rd ad hoc pattern.

## Toasts — the one fully-adopted shared primitive

`toast()` / `richToast()` (defined once, `app/src/shell/onboarding.js:~1211`)
render into a single `#richToastStack` node, typed `success | error | warning
| info` with a Lucide icon per type. Used from 27 of ~30 feature/shell
source files — this is the most consistently reused UI behavior in the
codebase and the model for what a shared primitive should look like. Any
transient user-facing feedback (success/error/info after an action) should go
through `toast()`, not a bespoke inline message.

## Accessibility baseline

A dedicated, clearly-labeled a11y block exists at the end of `styles/app.css`
(lines ~5258-5312): global `:focus-visible` fallback ring, `.skip-link`
(off-screen until focused, wired to `#main-content`), `.sr-only`, and
`prefers-reduced-motion` neutralization. The main tab bar has full, correct
ARIA-tabs wiring (`role="tablist"`/`"tab"`/`"tabpanel"`, cross-referenced
`aria-controls`/`aria-labelledby`/`aria-selected`). Build on these patterns;
don't reinvent them per feature.

**Known gaps (see audit for the full prioritized list):**
- Modal dialogs lack `role="dialog"`/`aria-modal`/focus-trap (all 16).
- Icon-only buttons are mostly unlabeled: only 9 `aria-label` attributes exist
  in `index.html` against dozens of icon-only buttons defined in CSS.
- Individual `:focus`/`outline` rules (46 of them) are inconsistent — some
  set only a border-color change with no visible ring, relying on the global
  fallback rather than an explicit, generous focus indicator.

Minimum bar for any new interactive element: keyboard reachable (real
`<button>`/`<a>`/`<input>`, not a `<div onclick>`), visible focus state
(inherits the global fallback, or better, sets an explicit one), and an
accessible name (visible text, or `aria-label` if icon-only).

## What NOT to do

- Do not introduce React, Vue, Tailwind, or any component framework to
  "modernize" this — the vanilla stack is deliberate (see
  `skills/verify-frontend-edit/SKILL.md`).
- Do not hand-edit `js/app.js`, `mind-ui.js`, or any other generated
  `js/<feature>.js` — edit the source and rebuild.
- Do not add mobile breakpoints, viewport meta tags, or safe-area handling —
  this is a desktop-only Electron shell.
- Do not silently migrate legacy `.btn`/`.modal-btn` call sites, `.empty-state`
  call sites, or bespoke card look-alikes as a side effect of an unrelated
  change — each is a deliberate, reviewed cleanup pass (see the audit's
  priority list), not a drive-by refactor.
- Do not invent a new spacing scale, color role, or empty/error pattern
  without updating this document in the same change.
