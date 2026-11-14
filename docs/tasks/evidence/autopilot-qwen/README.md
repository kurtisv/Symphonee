# Dashboard evidence (isolated Windows preview)

The PNGs were captured using installed Microsoft Edge on Windows, headless via
Playwright, with the actual before/after autopilot renderer module and synthetic
API fixtures. No active application, autopilot state, paid provider or production
endpoint was touched. They are **not** proof of an end-to-end live Electron run.

- `before-desktop.png`: renderer from base HEAD, 1280 x 900 viewport.
- `after-desktop.png`: working renderer, same fixture and viewport.
- `after-mobile.png`: working renderer at 390 x 844; inspected for horizontal fit.
- `capture.cjs`: reproducible isolated capture; runs from repository root with
  `node docs/tasks/evidence/autopilot-qwen/capture.cjs`. Requires playwright-core
  and installed Edge. Dependencies may be supplied through NODE_PATH.

The capture also opens the advanced disclosure, changes the history filter and
presses Tab. It fails on browser JavaScript errors. These limited interactions
do not constitute a comprehensive WCAG certification.

Automated frontend checks:

```
node --test dashboard/public/mind-ui/src/autopilot-interaction.test.mjs dashboard/public/mind-ui/src/autopilot-state.test.mjs dashboard/public/mind-ui/src/latest.test.mjs
node scripts/build-renderer.js
```

Seven tests passed: pilot changes during HTTP, WebSocket winning over late HTTP,
duplicate polling suppression, confirmation before stopping, independent Qwen
consents, per-pilot timestamp ordering and missing timestamps. The two new
snapshot-store tests were first run red (module absent), then green.

Remaining manual release checks: live isolated Electron API/WebSocket integration,
all production themes' contrast, screen reader navigation and actual Qwen CLI
availability/authentication. Deployment and restarting the user's application
require final approval.
