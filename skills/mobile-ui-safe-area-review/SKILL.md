---
name: Window and panel resize review
description: Symphonee's dashboard is a desktop-only Electron shell with NO phone/tablet target -- this skill replaces a generic "mobile safe area" check with what actually matters here -- narrow-window and narrow-panel layout, since there is no viewport meta tag or safe-area-inset usage anywhere in the app by design.
when: resizing, collapsing, or adding a panel/rail that could be viewed in a narrow Electron window, or before assuming this app needs phone/tablet handling
tags: ui, responsive, window-resize, dashboard
---

# Window and panel resize review

**Read this first: this skill is not what its generic name implies.**
`dashboard/public/index.html` has no `<meta name="viewport">` tag and
`styles/app.css` has zero `safe-area-inset-*` usage anywhere -- confirmed by a
full-codebase check. That is correct and deliberate: Symphonee's dashboard is
an Electron desktop shell, not a responsive web app, and it has no phone or
tablet target. Do not add viewport meta tags, safe-area-inset handling, or
touch-target sizing rules "for mobile" -- there is nothing to serve them to.

What DOES matter here, and what this skill actually reviews, is **in-app
window and panel resize behavior** -- the four real `@media` blocks that
exist in `styles/app.css` are all about this, not device classes:
- `@media (max-height: 720px)` / `(max-height: 560px)` -- shrinks the
  embedded "Apps" automation viewport panel when the window is short.
- `@media (max-width: 900px)` -- collapses the Mind panel's rail-beside-detail
  layout to a stacked column on a narrow window.
- `@media (prefers-reduced-motion: reduce)` -- an accessibility feature, not a
  layout breakpoint (covered by `accessibility-wcag-aa-review` instead).

## Use when
- Adding a new panel, rail, or side-by-side layout that could break when the
  Electron window is resized narrower or shorter than its design width/height.
- Someone asks for "mobile" or "responsive" handling on this dashboard --
  clarify with them whether they mean in-app window resizing (real, supported)
  or an actual phone/tablet target (out of scope, would need a completely
  different rendering strategy, and is not what this app is).

## Do not use when
- The user is asking about a genuinely different, separate product that DOES
  target phones/tablets (e.g. a companion mobile app) -- this skill is scoped
  to the Electron dashboard renderer only.
- The change has no layout implication (pure logic, IPC, backend).

## Steps (primary path)
1. Identify whether the new UI has a minimum comfortable width/height. If it's
   a side-by-side (rail + detail) layout, decide the breakpoint at which it
   should stack, matching the existing `900px` pattern used by the Mind panel
   unless there's a specific reason to differ.
2. Test the actual Electron window at a few realistic sizes: default size, a
   half-screen-width snap, and a short window (laptop with a small vertical
   resolution or a window resized short). Confirm nothing overflows,
   clips, or becomes unreachable (e.g. a footer button pushed off-screen with
   no scroll).
3. If a panel has fixed-width rails (`--sidebar-w`/`--intel-w`, both 300px),
   confirm the new content still reads acceptably when those rails are
   present AND when the user has collapsed them (check for a collapse
   affordance already in the sidebar/intel panel before assuming one needs to
   be built).
4. Do NOT add: viewport meta tags, `safe-area-inset-*`, touch target minimum
   sizes (44x44 px guidance is a phone/touchscreen concern), or a mobile
   navigation pattern (hamburger menu, bottom tab bar). If you find yourself
   adding any of these, stop -- you are solving a problem this app doesn't
   have.

## Safety
- The absence of mobile handling is a deliberate architectural fact, not a
  gap to close. Re-litigating "should we support mobile" is a product
  decision for the user to make explicitly, not something to default into
  while fixing an unrelated panel.
- Don't let a real narrow-window bug get dismissed as "mobile, not our
  problem" -- Electron windows ARE resized by users on real desktops; that
  case is in scope even though phones are not.

## Verification
- The panel was actually resized in the running Electron app (not just
  read in code) at default, half-width, and short-height, per
  `visual-qa-before-commit`.
- No `<meta name="viewport">` or `safe-area-inset-*` was added.
- Any new `@media` breakpoint is justified by an actual in-app layout need
  (window/panel size), documented with a comment the way the existing four
  blocks are.
