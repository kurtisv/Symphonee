---
name: Modal and form polisher
description: Fix modals and forms in the Symphonee dashboard to have correct dialog semantics (role, aria-modal, focus trap), consistent field markup, working validation/error messages, and .sy-btn footers -- closing the specific, confirmed gap that all 16 existing modals lack role="dialog"/aria-modal/focus-trap.
when: creating a new modal/dialog, or fixing alignment/validation/accessibility issues in an existing one
tags: ui, modal, forms, accessibility, dashboard
---

# Modal and form polisher

A full-codebase check found **16 modal dialogs** in `dashboard/public/`
(13 `.modal-overlay` blocks in `index.html` -- `createModal`,
`appsInstructionsModal`, `appsAutomationsModal`, `factoryResetModal`,
`settingsModal`, `registryModal`, `spaceModal`, `repoModal`, `branchModal`,
`gitModal`, `confirmDialog`, `promptDialog`, `browserAgentDetailModal` -- plus
3 `.pr-comment-modal`-classed dialogs nested in the PR panel:
`prCommentModal`, `wiCommentModal`, `prRequestChangesModal`) and confirmed
**none of them** have `role="dialog"`, `aria-modal="true"`, or a documented
focus trap. This is the highest-priority, most concrete fix this skill exists
to make, alongside the two competing form-field conventions.

## Use when
- Adding any new modal/dialog/popup.
- Touching an existing modal for any reason (bug fix, new field, restyle) --
  bring it up to the current bar while you're in there, don't just patch
  around the gap.
- Fixing form validation, error messages, alignment, or spacing in a modal or
  a settings/sidebar form.

## Do not use when
- The change doesn't touch a modal or a form field.
- A non-modal, non-form UI element (see `dashboard-ui-reviewer` instead).

## Steps (primary path)
1. Dialog semantics -- every modal's outer element needs:
   - `role="dialog"` and `aria-modal="true"`.
   - `aria-labelledby` pointing at the modal's visible title element's id.
   - Focus moved to the first focusable element (or the modal container
     itself) on open; focus returned to the element that triggered the modal
     on close.
   - A focus trap: Tab/Shift+Tab cycles within the modal, doesn't escape to
     the page behind it.
   - Escape key closes the modal; click on the overlay backdrop closes it --
     match the existing open/close behavior in `settingsModal` (the largest,
     most complete existing modal) rather than inventing new behavior.
2. Footer buttons: use `.sy-btn` variants (primary action = default `.sy-btn`
   or `.sy-btn-destructive` for a destructive confirm; secondary/cancel =
   `.sy-btn-outline` or `.sy-btn-ghost`) -- not `.modal-btn`/`.modal-btn-primary`.
   New modals should not add another `.modal-btn` usage.
3. Form fields inside the modal: use `.modal-field` markup consistently for
   every `input`/`select`/`textarea`. Never inline-style a field to duplicate
   `.modal-field` (the `mcpNewEnv` textarea in `index.html:1584` currently
   does this -- a known cleanup target, not a pattern to repeat).
4. Every field needs a real `<label>` (or `aria-label` if a visible label
   genuinely doesn't fit) -- never placeholder-only.
5. Validation and errors: show the error inline, next to the field it belongs
   to, with `aria-describedby` linking the field to the error text. For a
   whole-form failure (e.g. save failed), use `toast(msg, 'error')` --
   consistent with the rest of the app -- rather than a bespoke modal-level
   error banner (no such class exists yet; don't invent a one-off).
6. Spacing/alignment: match the existing modal padding/gap conventions in
   `styles/app.css`'s Modal / Settings modal sections rather than introducing
   new values.

## Safety
- Do not silently retrofit all 16 existing modals with dialog semantics as a
  side effect of touching one of them -- fix the one you're working on
  properly, and flag the other 15 as a known, tracked gap (see the UI/UX
  audit) rather than expanding the diff unpredictably.
- A focus trap that never releases focus (can't Tab out even after the modal
  closes) is worse than no trap -- verify close behavior restores normal tab
  order, don't just verify open behavior.
- Don't remove existing working behavior (e.g. an existing close handler)
  while adding ARIA attributes -- additive first, verify, then simplify only
  if genuinely redundant.

## Verification
- The modal has `role="dialog"`, `aria-modal="true"`, and `aria-labelledby`
  in the actual rendered DOM (inspect it, don't just trust the source).
- Tab and Shift+Tab cycle only within the modal while it's open; Escape and
  backdrop-click both close it; focus returns to the trigger element after
  close.
- Footer buttons are `.sy-btn`-based.
- Every field has an associated label; every inline error uses
  `aria-describedby`.
- Exercised live per `visual-qa-before-commit`, not just read in source.
