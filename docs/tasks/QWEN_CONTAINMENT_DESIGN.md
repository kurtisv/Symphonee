# Qwen Code confinement: design investigation

Status: **not implemented; fallback remains disabled**. Qwen Code 0.27.3 is installed on the investigation machine. Neither Docker nor Podman is available there, and the installed CLI's authentication has not been verified. No paid inference was made.

The user authorizes Qwen to write to the repository. That authorization does not include pushing changes, disclosing credentials, or changing the no-push/no-deploy guarantees. Worktree writes remain subject to Codex review and the existing validation gates.

## Findings

* On Windows, Qwen's official container sandbox needs Docker or Podman. Qwen 0.27.3 also mounts its settings and runtime directories and the user's temporary directory; `SANDBOX_FLAGS` can widen container options. A `-s` flag alone is not a proof of a bounded filesystem or process lifetime.
* Docker/Podman daemon processes are not descendants of Symphonee's Windows Job. Its existing Job-object evidence alone cannot prove that a container stopped.
* A linked Windows worktree stores `.git` metadata in the main repository's common Git directory and records host-specific paths. Simply mounting the worktree under Linux does not prove Git works. Giving an autonomous `--approval-mode yolo` worker write access to the common Git directory also lets it modify refs, config, hooks and the object store, and might allow push or other external actions. User permission for repository writes does not waive those conditions.
* Mounting the Qwen authentication directory inside the same networked container as model-controlled shell commands makes the credentials readable by those commands. A generic network bridge permits outbound connections; neither it nor a prompt instruction prevents exfiltration or push.
* A timed-out Docker start request can still be in flight. Inspecting an unstarted or stopped container is not by itself proof it cannot start later. A pilot's current timeout/halt logic also sets `enabled=false`; peer exclusion cannot depend solely on the enabled flag while a container might still write.

## Candidate architecture (requires design and proof)

1. Use a dedicated, digest-pinned runtime image and explicitly controlled mounts. Test a linked worktree against a real Windows container engine. The Git metadata strategy must either restrict Git operations independently of the model-controlled shell or use isolated metadata and a reviewed, deterministic transfer into the original retained worktree. The latter must explicitly preserve the same-worktree, fingerprints and approved-plan contracts; a silent copy-back is insufficient.
2. Hold provider credentials outside the tool-execution sandbox. An authenticated broker/proxy could issue only the permitted model calls while the tool environment has no direct access to credentials or unrestricted outbound network. Define exact endpoint, DNS/TLS, redirect, proxy-bypass and data-handling rules and prove that shell commands cannot reach the broker socket or other destinations. Qwen CLI compatibility and authentication flows must be verified rather than assumed.
3. Persist a unique attempt and exclusive intensive-work lease before creating the daemon-owned container. Persist its immutable ID before start. Inspect image, mount sources and modes, runtime settings, entrypoint and network configuration. After cancellation, timeout, crash or completion, independently reconcile and terminate/remove the exact owned container with confirmed daemon responses; retain the lease on any ambiguous response. A daemon restart, pending start, absent container and a failed inspect each need explicit race-tested handling.
4. Both autopilots must consult the durable lease even if the owning pilot is disabled or Symphonee restarts. Cancellation must not mark work as safely finished until container termination is proved. Never retry an ambiguous start. Keep the existing independent Codex review and reviewer reservation.
5. Keep `canConfineProvider('qwen')` unavailable until a controlled Windows test verifies Qwen's actual image, Git operations, authentication boundary, blocked push, network boundaries, cancellation, timeout, daemon failure and restart recovery. Such tests must not spend provider tokens or modify live autopilots. An authenticated paid smoke test, if eventually needed, must be explicitly budgeted and separately disclosed.

A possible way to keep the original files in the same worktree while avoiding writes to live Git metadata is to bind-mount the worktree itself, overlay its `.git` entry read-only, and use a separate, disposable Git metadata copy with explicit `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE`. This is a design hypothesis: verify linked-worktree paths, Windows bind-mount and rename behavior, Git locks, ignored/junction paths and approved base SHA on a real engine before adopting it. The metadata copy must never be merged back into the source repository. The authentication broker likewise needs per-attempt budgets and must inject the real credential outside the worker's reachable filesystem; the model still receives the project material explicitly sent for cloud inference.

## Evidence and boundaries

An exploratory implementation exercised a fake daemon, persistent lease, cancellation and real local Windows Git linked-worktree setup. The combined autopilot and prototype suites reported 77 passing tests. These results do not validate Docker, provider authentication, network isolation or the complete handoff. Independent review found the Git and credential exposures above; the experimental adapter was removed and the existing fail-closed Qwen guard remains in place.

Official reference: https://qwenlm.github.io/qwen-code-docs/en/users/features/sandbox/
