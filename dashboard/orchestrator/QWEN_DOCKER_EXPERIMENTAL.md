# Qwen Docker worker: experimental, disabled by default

This worker produces a proposed diff only; it does not apply changes. It is
not approved for real repositories. `QwenDocker.enabled` must remain unset or
false outside controlled experiments.

Security review identified unresolved limits:

- On Windows, checking paths and then opening them is not atomic. A junction
  can potentially be replaced and restored during the read. Snapshot hashes
  before and after the task detect ordinary changes but do not close that race.
- A JavaScript module under test can call `process.exit(0)` before assertions
  execute. A zero exit code is not proof that tests actually ran.
- A Docker create request interrupted at the client could theoretically finish
  at the daemon after the cleanup check. Docker daemon failure may also make
  cleanup impossible to verify. Such errors must not be treated as success.
- A proposed diff is untrusted. Before any later application, check the source
  hashes and Git state again, and require an independent human review.

The confined Docker execution and three synthetic examples are evidence for
the tested setup only, not certification for production use.
