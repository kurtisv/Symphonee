---
name: Figma to code handoff
description: Turn a Figma design or a screenshot into dashboard UI code that actually fits Symphonee's stack -- vanilla HTML/CSS/JS with the existing .sy-* primitives and theme tokens, not React/Tailwind output that would need a full rewrite to use.
when: the user shares a Figma link/screenshot and wants it implemented in the dashboard, or asks what design tooling is available
tags: figma, design-to-code, tooling, dashboard
---

# Figma to code handoff

The biggest risk in this workflow isn't the translation itself -- it's
pulling in a tool that generates React/Tailwind code for a codebase that has
neither. This skill's checklist exists specifically to keep the tooling
choice honest, verified against official docs at the time each tool was
checked (2026), and compatible with the actual stack (see
`DESIGN_SYSTEM.md`'s "Stack reality" section).

## Use when
- The user shares a Figma file/frame and wants it built as dashboard UI.
- The user shares a screenshot/mockup and wants matching code.
- The user asks what UI/UX tooling is available or installable.

## Do not use when
- The ask is a small tweak to existing UI with no new design reference (use
  `design-system-guardian`/`dashboard-ui-reviewer` instead).

## Steps (primary path)
1. Get the design context. The **Figma MCP connector is already available in
   this environment** (confirmed live, not just documented) -- use
   `get_design_context` / `get_screenshot` / `search_design_system` on the
   given Figma URL to pull the real node structure, styles, and a screenshot,
   rather than guessing from a description.
2. Map every design token in the Figma output to an existing Symphonee token
   or primitive before writing any CSS:
   - Figma color styles -> the closest existing semantic role
     (`--surface0/1/2`, `--accent`, `--red`, etc.) -- do NOT copy a raw hex
     value from Figma into `styles/app.css`.
   - Figma "button" components -> `.sy-btn` + the matching variant/size.
   - Figma "card" components -> `.sy-card` + header/content/footer parts.
   - Figma spacing -> the nearest value already in common use (see
     `DESIGN_SYSTEM.md`, no numeric scale exists yet).
   - If Figma has a color/spacing value with no reasonable existing mapping,
     say so explicitly and propose it as a considered addition to
     `DESIGN_SYSTEM.md` -- don't silently invent a one-off.
3. Write the implementation as vanilla HTML fragments / template-literal
   strings matching the existing pattern in whichever panel this belongs to
   (see how `work-items/src/index.js` or `settings/src/index.js` build
   markup) -- never emit JSX or a React component.
4. Verify against the Figma screenshot side-by-side with the live app in at
   least one dark and one light theme (colors will differ from the Figma mock
   by design -- structure/spacing/hierarchy should match, not literal color
   values from a single Figma theme).
5. Run `visual-qa-before-commit` before considering the handoff done.

## Tooling landscape (verified 2026, re-verify before relying on this if it's been a while)

**Connected and usable right now, no setup needed:**
- **Figma MCP** (`mcp__claude_ai_Figma__*`) -- official, already live in this
  environment. Use this, not a screenshot description, whenever a Figma link
  is given.

**Real, official, and would fit this stack IF installed (not currently
connected -- would need the user to add them as MCP servers):**
- **Playwright MCP** (`microsoft/playwright-mcp`, github.com/microsoft/playwright-mcp)
  -- official Microsoft server, browser automation via accessibility-tree
  snapshots. Framework-agnostic; works against the Electron renderer's
  Chromium webview. Good fit for `visual-qa-before-commit` automation.
- **Chrome DevTools MCP** (`ChromeDevTools/chrome-devtools-mcp`,
  github.com/ChromeDevTools/chrome-devtools-mcp) -- official Google server
  (public preview), console/network/performance inspection via Chrome/Chrome
  for Testing. Electron's renderer is Chromium, so this applies directly.
- **Context7** (`upstash/context7`) -- official Upstash server, up-to-date
  library docs by resolve-then-query. Framework-agnostic (useful for
  Electron/esbuild/xterm.js docs, not just frontend frameworks).
- **Axe accessibility MCP** -- an official Deque server exists
  (deque.com/axe/mcp-server), plus several community MCP servers wrapping
  `axe-core` (e.g. `priyankark/a11y-mcp`). `axe-core` itself is
  framework-agnostic and runs against any DOM, so it applies to this app
  despite having no React -- pairs with `accessibility-wcag-aa-review`.
- **Canva MCP** (`canva.dev/docs/mcp`, mcp.canva.com) -- official, two
  variants (general design-asset MCP and a dev-docs MCP). Only relevant if
  Symphonee needs marketing/branding assets, not for dashboard UI engineering
  itself -- lower priority, don't install it just for this skill.

**Real tools that do NOT fit this stack -- do not install these for
Symphonee's dashboard specifically:**
- **shadcn/ui MCP** (ui.shadcn.com/docs/mcp) -- official, but browses/installs
  React + Tailwind components from a registry. This dashboard has neither.
  The existing `.sy-*` layer is already shadcn-*inspired* in naming/feel by
  design (see its CSS comment), which is as far as the analogy goes -- don't
  pull in the actual shadcn tool expecting compatible output.
- **21st.dev Magic MCP** (`21st-dev/magic-mcp`) -- official, but explicitly
  generates React + Tailwind code from natural-language prompts. Same
  incompatibility as shadcn/ui MCP. Could be used purely for *visual
  inspiration* (looking at generated component ideas) if the user wants that,
  but never for direct code output into this repo.
- **Storybook MCP** (`storybook.js.org/docs/ai/mcp`) -- official, but as of
  Storybook 10.3 "currently only supported for React projects" per Storybook's
  own docs. Would require adopting both React and Storybook to use --  a much
  bigger, separate architectural decision, not something to bundle into a
  design-handoff task. There is no existing Storybook config in this repo
  (confirmed).

## Safety
- Never introduce React, Tailwind, or a component registry as a side effect
  of using one of these tools' example output -- translate the *design*, not
  the *code*, when the tool's native output format doesn't match this stack.
- Don't claim a tool is "installed" or "available" without checking --
  distinguish clearly between "connected in this session" (Figma MCP) and
  "exists and is installable" (everything else in this list) when reporting
  to the user.
- Re-verify official docs before recommending an install if this list is
  more than a few months old -- MCP tooling moves fast.

## Verification
- The implemented UI uses only existing Symphonee tokens/primitives, not
  literal values lifted from the Figma file.
- Side-by-side comparison against the Figma screenshot confirms structural/
  spacing/hierarchy fidelity.
- No React/Tailwind/JSX was introduced anywhere in the diff.
- `visual-qa-before-commit` was completed.
