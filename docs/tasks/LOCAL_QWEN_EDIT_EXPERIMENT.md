# Local Qwen editing experiment

Status: **experimental only; not connected to autopilots and not ready to activate**.

The prototype receives one previously selected file, asks a local tool-less model for an exact replacement, validates the file path, original hash and unique match, and then can apply that replacement through a checked Windows file handle. It has no shell or cloud tool. A failed or interrupted write has an unknown outcome and requires the caller to stop and inspect the worktree; an automatic retry is unsafe.

The Windows prototype compares the requested and resolved paths, pins the root's volume/file identity and rejects target reparse points, hardlinks, binary files and oversized files. Protected-path policy must be provided again before apply. This does not itself establish that the root is the approved autopilot worktree: a production caller must independently validate the registered repo, worktree origin, branch/base SHA, approved plan, exclusive lease, Claude termination, allowed paths, protected paths and independent Codex review. Snapshot provenance must be bound to that approved state. No runtime wiring is provided here.

## Synthetic local measurements

With `qwen2.5-coder:3b`, Windows and Ollama, four one-shot synthetic cases were run with explicit schema and temperature 0. The exact positive correction was applied in an isolated synthetic directory. In the absent-function case and the external-path instruction case the validator rejected an invalid proposal; the recorded data does not establish semantic abstention. A source comment that instructed the model to change code caused it to edit despite an objective explicitly requiring no changes. This result is too small to characterize general performance and decisively shows that the prototype must not be enabled autonomously. No generated code was executed, no cloud provider was called, and no active autopilot was modified.

Run `node scripts/benchmark-local-edit.js --run` on Windows with loopback Ollama and `qwen2.5-coder:3b` installed. It creates only randomly named synthetic directories under `.ai-workspace`; it does not contact Mind or mutate any real repo file. Without `--run` it prints help and does not invoke inference. Model output can vary between runs. A failed case returns a nonzero exit status.

## Required before integration

- Establish target/worktree/plan authorization before reading and again before writing. Abort on changed root, branch, fingerprint, base SHA, lease or protected-path policy.
- Preserve process-tree termination proof and a durable exclusive lease when Claude is interrupted. Persist any ambiguous write as requiring human inspection; do not replay it after restart.
- Obtain independent Codex review of the proposed change before application, and retain all existing post-application verification and review gates. A model-originated instruction in a source file is untrusted, and a valid hash does not establish that a change is correct.
- Test crash, cancellation, concurrent operations, access controls, and the actual autopilot pipeline on isolated fixtures. Establish an evaluation suite with realistic positive and adversarial negative examples, and only enable a model when the agreed quality bar is met.
