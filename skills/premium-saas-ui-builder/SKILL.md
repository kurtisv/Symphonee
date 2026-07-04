---
name: Premium SaaS UI builder
description: Build new dashboard UI that looks and feels like a polished, professional desktop tool (not a generic admin template) by using Symphonee's actual design language -- the six-theme semantic color system, the .sy-* primitive layer, and the toast system -- consistently and with real visual craft, not just correctness.
when: building a new panel, feature surface, or significant visual piece of the dashboard from scratch
tags: ui, quality, dashboard, craft
---

# Premium SaaS UI builder

This skill is about craft, not just compliance with `DESIGN_SYSTEM.md` --
using the right classes is necessary but not sufficient for a UI that feels
premium rather than generic. Symphonee already has real design maturity to
build on: a proper six-theme (3 dark, 2 light, 1 custom) semantic color
system, a shadcn-inspired primitive layer (`.sy-btn`/`.sy-badge`/`.sy-card`/
`.sy-empty`), and a well-adopted toast system. The failure mode this skill
guards against is technically-correct-but-flat UI: right classes, no
hierarchy, no motion, no polish.

## Use when
- Building a new panel or feature surface from scratch.
- The user says the UI feels "generic", "flat", "not premium enough", or asks
  for a visual upgrade to an existing panel.

## Do not use when
- Making a small, targeted bug fix with no visual design decisions involved.
- The task is pure accessibility or design-system-compliance work with no
  new visual design to create (use `accessibility-wcag-aa-review` or
  `design-system-guardian` instead).

## Steps (primary path)
1. Establish visual hierarchy deliberately: one clear primary action per
   view (`.sy-btn` default variant), secondary actions as `.sy-btn-outline`/
   `-ghost`, and destructive actions as `.sy-btn-destructive` -- never three
   default-variant buttons competing for attention in the same view.
2. Use `.sy-card-interactive`'s hover lift (`transform: translateY(-1px)` +
   shadow change) for genuinely clickable cards -- it already exists, use it
   instead of a flat static card for anything the user can click into.
3. Use the semantic badge variants (`-success`/`-warning`/`-destructive`) to
   carry status at a glance rather than relying on text alone ("Active",
   "Failed", "Pending" should each look distinct, not just read distinct).
4. Empty states are a craft opportunity, not an afterthought: use `.sy-empty`
   with a real icon (Lucide, matching the icon set already used in
   `richToast()` and elsewhere), a specific title ("No pull requests yet",
   not "No data"), and an action button when there's an obvious next step
   ("Create your first X").
5. Respect the active theme -- test the new UI in at least one dark theme
   (`industrial-blue`, the default) AND one light theme (`arctic-frost` or
   `warm-sand`) before considering it done. A design that only works in one
   theme family isn't finished.
6. Motion: keep transitions in the 0.06s-0.15s range already used by `.sy-btn`/
   `.sy-card-interactive` (`filter 0.12s`, `transform 0.06s`, etc.) -- longer
   feels sluggish for a desktop tool, and respect
   `prefers-reduced-motion` (already globally neutralized, so this is usually
   automatic, but verify a custom animation doesn't bypass it).
7. Density: this is a data-dense desktop dashboard, not a marketing page --
   err toward compact spacing consistent with existing panels rather than
   generous whitespace copied from a consumer web aesthetic.

## Safety
- "Premium" is not license to invent new colors, fonts, or components outside
  `DESIGN_SYSTEM.md` -- the existing token/primitive system is already
  capable of a polished result; the craft is in how it's composed, not in
  adding new primitives.
- Don't add a new icon library or font alongside the existing Lucide icons /
  `--font-ui`/`--font-mono` set.
- Don't build something that only looks good in the default theme -- check
  both a dark and a light theme before calling it done (see
  `visual-qa-before-commit`).

## Verification
- The new UI uses only existing tokens/primitives, composed with clear
  hierarchy (one primary action, distinguishable status, purposeful empty
  states).
- Verified live in both a dark and a light theme.
- No new dependency (icon set, font, animation library) was introduced.
