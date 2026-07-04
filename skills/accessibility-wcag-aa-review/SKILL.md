---
name: Accessibility WCAG AA review
description: Verify contrast, labels, aria attributes, focus states, keyboard navigation, and semantic HTML against WCAG 2.1 AA for the Symphonee dashboard, building on its real (uneven) existing a11y baseline rather than assuming a blank slate.
when: adding or changing interactive UI, especially icon-only buttons, modals, and anything with custom focus/keyboard behavior
tags: accessibility, wcag, a11y, dashboard
---

# Accessibility WCAG AA review

The dashboard is not a blank slate for accessibility: a dedicated, clearly
labeled a11y block exists at the end of `styles/app.css` (global
`:focus-visible` fallback ring, a working `.skip-link` wired to
`#main-content`, `.sr-only`, and `prefers-reduced-motion` handling), and the
main tab bar has fully correct ARIA-tabs wiring. The gaps are specific and
known, not generic: modal dialogs, icon-only button labeling, and some
individual focus styles. This skill's job is to close the known gaps and
prevent new ones, not to relitigate the parts that already work.

## Use when
- Adding any new interactive element (button, link, form control, custom
  widget) to the dashboard.
- Adding or touching a modal (pair this with `modal-and-form-polisher`).
- The user asks for an accessibility pass or mentions WCAG/a11y/screen
  readers/keyboard navigation.

## Do not use when
- The change has no user-facing interactive element (pure backend/IPC/state).

## Steps (primary path)
1. Keyboard reachability: every interactive element is a real `<button>`,
   `<a>`, or form control -- never a `<div onclick>` or `<span onclick>` with
   no keyboard equivalent. If you must use a non-native element, it needs
   `tabindex="0"`, a `role`, and both click and Enter/Space keydown handling.
2. Focus visibility: confirm the element gets a visible focus indicator. The
   global `:focus-visible` fallback (`outline: 2px solid var(--accent)`)
   covers anything that doesn't set its own, but verify nothing sets
   `outline: none` without providing an equivalent replacement (several
   existing inputs use only a `border-color` change on focus, which is weaker
   than a ring -- don't add a new instance of that pattern).
3. Accessible names: every icon-only button needs `aria-label`. The app
   currently has only 9 `aria-label` attributes in `index.html` against many
   more icon-only buttons in the CSS -- treat any icon-only button you touch
   or add as needing one, don't assume it already has it.
4. Modal/dialog semantics: `role="dialog"`, `aria-modal="true"`,
   `aria-labelledby`, and a real focus trap -- see `modal-and-form-polisher`
   for the full checklist (confirmed gap on all 16 existing modals).
5. Live regions: if the change introduces dynamically-updating status text
   that isn't already inside a toast, check whether it needs to be announced
   via the existing `#a11yLive` (`aria-live="polite"`) region rather than a
   new one.
6. Semantic structure: prefer real landmarks (`<nav>`, `<main>`, `<footer>`)
   over `role="..."` on a `<div>` when adding a genuinely new top-level
   region -- the app currently fakes `<main>` via `role="main"` on a div;
   don't perpetuate that pattern in new top-level structure if a real element
   works.
7. Color contrast: when adding a new color combination (e.g. a new badge
   variant, new text-on-surface pairing), check it against WCAG AA (4.5:1 for
   normal text, 3:1 for large text/UI components) in EACH theme it will
   render in, not just the default `industrial-blue` -- the light themes
   (`arctic-frost`, `warm-sand`) can fail contrast checks that the dark themes
   pass, and vice versa.
8. `prefers-reduced-motion`: any new CSS animation/transition should respect
   the existing global neutralization -- verify it doesn't hard-code an
   animation the media query can't override (e.g. via `!important` or an
   inline style).

## Safety
- Don't claim a full WCAG AA pass for the whole app based on fixing one
  component -- scope the claim to what was actually reviewed.
- Fixing accessibility on the element you're touching does not require
  auditing all 16 modals or every icon button in the app in the same change
  -- flag the broader gap (see the UI/UX audit) rather than silently
  expanding scope.
- Don't remove an existing `aria-*` attribute you don't understand without
  checking what relies on it first.

## Verification
- Keyboard-only pass: Tab through the changed UI, confirm every interactive
  element is reachable in a sensible order and operable with
  Enter/Space.
- Screen-reader spot check (or at minimum, read the accessible name/role/state
  each element would expose) confirms icon-only controls announce their
  purpose.
- Contrast checked in at least one dark and one light theme for any new color
  pairing.
- If a tool from `figma-to-code-handoff`'s tooling list (axe-core, an MCP a11y
  scanner) is available, run it against the changed panel and note the result
  -- but do not claim a scan ran if it didn't; say so explicitly instead.
