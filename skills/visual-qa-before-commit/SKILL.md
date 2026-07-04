---
name: Visual QA before commit
description: Before committing a UI change to the Symphonee dashboard, rebuild the renderer, reload the live app, and actually exercise the touched UI across both a dark and a light theme -- catching GUI-only regressions that node --check and unit tests cannot see.
when: after any change to dashboard/public HTML/CSS/JS source, before considering the task done or handing off to ship-a-change
tags: ui, qa, verification, dashboard, core
---

# Visual QA before commit

This is the mandatory final step for any dashboard UI change, building on
`verify-frontend-edit`'s build/syntax-check steps with the part those can't
cover: does it actually look and behave right when you look at it. A clean
build and a passing `node --check` are necessary but not sufficient --
GUI-only breakage (a misaligned modal, a button that doesn't respond, a color
that's unreadable in the light theme) is invisible to both.

## Use when
- Before every commit that touches `dashboard/public/` HTML, CSS, or any
  renderer source JS.
- Before telling the user a UI task is complete.

## Do not use when
- The change has no rendered UI surface (pure backend logic, scripts,
  non-renderer code).

## Steps (primary path)
1. Follow `verify-frontend-edit` first: edit source (never generated
   `js/*.js`), rebuild (`npm run build:renderer`), `node --check` both source
   and built output.
2. Reload the running Electron app (Ctrl+R, hard-reload if anything looks
   cached/stale).
3. Navigate directly to the changed panel/modal/component -- don't just glance
   at the app shell.
4. Exercise the actual interaction paths touched by the change: click every
   new/changed button, open every new/changed modal, trigger the empty state
   (no data), trigger the loading state, and trigger an error path if one
   exists -- not just the happy path.
5. Switch the active theme (via the in-app theme switcher) to at least one
   other theme from a different family than whatever you were building in --
   if you built in `industrial-blue` (dark), check `arctic-frost` or
   `warm-sand` (light), and vice versa. Confirm text stays readable, borders
   stay visible, and nothing relies on an assumption specific to one theme.
6. Resize the window narrower and shorter than default per
   `mobile-ui-safe-area-review` if the change touches a panel with
   side-by-side or fixed-width layout.
7. Check the browser/Electron devtools console for new warnings or errors
   introduced by the change (a silent console error is still a regression).

## Safety
- "The build succeeded" and "the tests pass" are not substitutes for this --
  say so explicitly if you have not actually looked at the running app, don't
  imply visual verification happened when it didn't.
- If you cannot actually run/reload the app in this session, say that
  explicitly to the user rather than claiming the UI change works.

## Verification
- The change was reloaded live, not just built.
- The specific interaction paths touched by the change were exercised, not
  just the panel's default view.
- At least two themes (one dark, one light) were checked.
- No new console errors/warnings.
- Only after all of the above: proceed to `ship-a-change` (diff shown as its
  own step, then commit).
