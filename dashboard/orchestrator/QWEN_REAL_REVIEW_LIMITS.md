# Experimental Codex reviewer: NO-GO

Codex CLI 0.169.0 is launched by Symphonee's existing spawnHeadless path.
Its read-only sandbox restricts execution permissions; it is not evidence that
every model tool is disabled or that personal files cannot be read. The
existing prompt's instruction not to use tools is not an enforced boundary.
The current launcher does not expose a verified tool-free Codex mode and the
existing fixture entry remains blocked on process containment and cleanup.

Follow-up: `codex features list` in installed CLI 0.169.0 reports both
`shell_tool` and `unified_exec` enabled and configurable. Disabling one shell
feature is not proof that all tools, patching, MCP, hooks, or code mode are
unavailable. OpenAI's Codex repository issue 60069 reports remaining tool
declarations in 0.164.0-alpha.11.1 despite multiple flags; this does not prove
the behavior of 0.169.0. Issue 58662 has an OpenAI contributor's assessment that
0.154.0 had no supported all-tools-off configuration. An authenticated,
version-specific proof for 0.169.0 remains outstanding.

Claude Code follow-up: the installed CLI help exposes `--tools ""` to disable
built-in tools, `--strict-mcp-config` to restrict MCP configuration and
`--safe-mode` to disable customizations. A Claude Pro login was detected.
These options have not been wired into spawnHeadless or independently verified
together; CLI help is not proof of effective permissions, process cleanup or
absence of personal context. Do not treat them as an approved reviewer yet.

No real review was launched during this assessment. Do not connect the fixture
loop to a reviewer by bypassing the existing lock or trusting model-supplied
hashes. The host must bind the exact diff, requirements and technical evidence
to the reviewer process and validate the structured response.

An official alternative is the OpenAI Responses API with no tools configured,
which requires separate API authentication and is billed at API rates. This is
not the existing ChatGPT subscription session; no API call is authorized by
this document. Other officially supported tool-denial mechanisms, if found,
must be verified on this installed CLI and on Windows before use.

The simulated fixture and real-project locks remain unchanged. Review Qwen's
output only in an isolated fictional fixture until all restrictions and
independent technical checks are demonstrated.

## 2026-11-14 follow-up: tool-free Codex fixture reviewer

`codex-no-tools.js` and the `reviewerNoTools` option of `spawnHeadless` use
only official switches of Codex CLI 0.169.0: `--disable` for 19 features
(shell, unified exec, code mode host, sub-agents, apps, plugins, browser and
computer use, image tools, hooks, skills search, daemon auto-start...),
`web_search="disabled"`, `mcp_servers={}` and `model_catalog_json` pointing to
a temporary copy of the local catalog entry with `tool_mode="direct"`, text-only
input and no patch, search or sub-agent tool. `--sandbox read-only`, `--json`,
`--ephemeral` and no shell are added; no trust entry is written to the user's
configuration and no API key is passed.

Before every launch, `codex debug prompt-input` with the same configuration and
working directory must declare only `functions.request_user_input`, otherwise
nothing is launched. Measured locally: the default read-only configuration
declares `exec` (code mode with nested `exec_command`, `apply_patch`,
`view_image`, MCP resources), `wait`, `sleep` and six `collaboration` tools; the
restricted configuration declares only `request_user_input`. After the run, the
`--json` events must contain only `agent_message` and `reasoning` items, and no
descendant of the launched process may survive; any other item, a surviving
process or an unverifiable process table voids the review.

Limits that remain: the proof is the client-side declaration and the observed
event stream of this installed version, not a kernel boundary; the catalog
override and feature flags are version-specific and must be re-proven after any
Codex update (the version is pinned and checked). The model-visible prompt
still contains Codex's built-in instructions and the OpenAI system skills list
(no personal content was found in it). A pre-existing Codex app-server daemon on
this machine is outside the verified process tree. These settings are allowed
only with the fixture safeguards and the fictional Qwen fixture entry; real
projects stay locked.
