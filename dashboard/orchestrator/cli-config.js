'use strict';
// CLI configuration + model intelligence for the orchestrator (pure data).
// Extracted from orchestrator.js. Verified against each CLI's --help output.

// Headless CLI flags per provider.
//   args:        base flags for headless/non-interactive mode
//   promptMode:  'stdin' | 'flag' (-p "prompt") | 'positional' (trailing arg)
//   shell:       spawn shell option (false avoids cmd.exe quoting issues)
const HEADLESS_FLAGS = {
  claude:  { cmd: 'claude',  args: ['-p'], promptMode: 'stdin' },
  gemini:  { cmd: 'gemini',  args: [],                   promptMode: 'stdin' },
  codex:   { cmd: 'codex',   args: ['exec'],             promptMode: 'stdin' },
  antigravity: { cmd: 'agy', args: ['-p'],               promptMode: 'flag', shell: false },
  copilot: { cmd: process.platform === 'win32' ? 'copilot.cmd' : 'copilot', args: ['-p'],     promptMode: 'flag',  shell: false },
  grok:    { cmd: process.platform === 'win32' ? 'grok.cmd'    : 'grok',    args: ['--print'], promptMode: 'positional', shell: false },
  qwen:    { cmd: process.platform === 'win32' ? 'qwen.cmd'    : 'qwen',    args: ['-p'],      promptMode: 'flag',       shell: false },
  // NOTE: `-m` is baked in here (not left to the caller) because `codex --oss` with no
  // explicit model defaults to auto-downloading OpenAI's own gpt-oss-20b (12+ GB) instead
  // of using whatever LM Studio already has loaded. spawnHeadless() only injects modelFlag
  // when a caller explicitly passes one, so without this default every unqualified spawn
  // would trigger that download. Model is Qwen2.5-Coder-1.5B (not 7B): on this machine's
  // CPU-only inference, 1.5B finishes Codex's ~12k-token system prompt in ~14 min vs
  // ~20 min for 7B -- pick 7B instead if quality matters more than turnaround.
  // Local provider (see local-providers.js). Pinned to LM Studio; spawn-headless
  // re-verifies this argv (fail closed) and strips every cloud key from its env.
  'codex-oss-local': { cmd: 'codex', args: ['exec', '--oss', '--local-provider', 'lmstudio', '-m', 'qwen2.5-coder-1.5b-instruct'], promptMode: 'stdin' },
  // 'claude-local' points Claude Code at the local LM Studio server via LM Studio's
  // native Anthropic-compatible /v1/messages endpoint (confirmed working, no proxy
  // needed) -- the ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_ATTRIBUTION_HEADER
  // env vars are injected in spawn-headless.js (only on the spawned child's env, never
  // process.env), same pattern as codex-oss's baked-in -m. Claude Code's own system
  // prompt measured at ~19,821 tokens -- bigger than Codex's -- so the local model must be
  // loaded with a big enough context (see local-ai-bin's claude-local.ps1, which uses 32768).
  'claude-local': { cmd: 'claude', args: ['-p', '--model', 'qwen2.5-coder-1.5b-instruct'], promptMode: 'stdin' },
};

// Grounded model availability per CLI and account type. Update when models change.
const CLI_MODELS = {
  claude: {
    models: ['opus', 'sonnet', 'haiku'],
    modelIds: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'sonnet',
    modelFlag: '--model',
    effortFlag: '--effort',
    effortValues: ['low', 'medium', 'high', 'max'],
    permissionFlag: '--dangerously-skip-permissions',
    autoPermission: true,
    outputFormatFlag: '--output-format',
    systemPromptFlag: '--append-system-prompt',
    worktreeFlag: '--worktree',
    extraHeadless: [],
    notes: 'All models work with both API key and subscription auth.',
  },
  gemini: {
    models: ['flash', 'flash-lite'],
    modelIds: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash'],
    paidModels: ['pro', 'gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview'],
    defaultModel: 'flash',
    modelFlag: '-m',
    effortFlag: null,
    permissionFlag: '--approval-mode',
    autoPermission: 'yolo',
    outputFormatFlag: '-o',
    systemPromptFlag: null,
    worktreeFlag: '--worktree',
    extraHeadless: [],
    notes: 'Free tier: flash/flash-lite only. Pro models require API billing enabled on Google Cloud project.',
  },
  codex: {
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.1-codex'],
    modelIds: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.1-codex', 'gpt-5.1-codex-mini'],
    apiKeyOnlyModels: ['o3', 'o4-mini', 'gpt-4.1'],
    notSupported: ['gpt-4o'],
    defaultModel: 'gpt-5.4',
    modelFlag: '-m',
    effortFlag: null,
    permissionFlag: '--dangerously-bypass-approvals-and-sandbox',
    autoPermission: true,
    outputFormatFlag: '--json',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'ChatGPT account: gpt-5.x models only. o3/o4-mini/gpt-4.1 require an OpenAI API key. gpt-4o is not available in Codex at all.',
  },
  antigravity: {
    models: [],
    modelIds: [],
    defaultModel: null,
    modelFlag: '--model',
    effortFlag: '--effort',
    permissionFlag: '--dangerously-skip-permissions',
    autoPermission: true,
    outputFormatFlag: null,
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'Uses local Google authentication and lets Antigravity choose its default model when none is specified.',
  },
  copilot: {
    models: ['claude-sonnet-4.6', 'gpt-5.4', 'gpt-4.1', 'gpt-5-mini'],
    modelIds: ['claude-opus-4.6', 'claude-sonnet-4.6', 'claude-haiku-4.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1', 'gpt-5.3-codex', 'gemini-3-pro-preview'],
    freeModels: ['gpt-5-mini', 'gpt-4.1'],
    defaultModel: 'claude-sonnet-4.6',
    modelFlag: '--model',
    effortFlag: '--effort',
    effortValues: ['low', 'medium', 'high', 'xhigh'],
    permissionFlag: '--yolo',
    autoPermission: true,
    silentFlag: '--silent',
    outputFormatFlag: '--output-format',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'gpt-5-mini and gpt-4.1 are free (no premium requests). Claude/GPT-5.4/Gemini consume premium requests. Requires Copilot Pro+ for premium models.',
  },
  grok: {
    models: ['grok-4', 'grok-3', 'grok-3-mini-fast'],
    modelIds: ['grok-4', 'grok-4-latest', 'grok-4.20', 'grok-3', 'grok-3-latest', 'grok-3-mini-fast', 'grok-code-fast-1', 'grok-4-1-fast-reasoning'],
    defaultModel: 'grok-3-mini-fast',
    modelFlag: '--model',
    effortFlag: null,
    permissionFlag: '--permission-mode',
    autoPermission: 'full',
    outputFormatFlag: '--output-format',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'All models require xAI API key with loaded credits. grok-3-mini-fast is cheapest.',
  },
  qwen: {
    models: ['qwen3-coder-plus', 'qwen3-coder-flash'],
    modelIds: ['qwen3-coder-plus', 'qwen3-coder-flash', 'qwen3-max', 'qwen3-max-preview', 'qwen-plus', 'qwen-turbo'],
    paidModels: ['qwen3-max', 'qwen-plus'],
    defaultModel: 'qwen3-coder-plus',
    modelFlag: '-m',
    effortFlag: null,
    permissionFlag: '--yolo',
    autoPermission: true,
    outputFormatFlag: '-o',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'Qwen Code is a Gemini CLI fork. Auth via DashScope (DASHSCOPE_API_KEY) or OpenAI-compatible endpoint. Qwen3-Coder models are code-specialized.',
  },
  'codex-oss-local': {
    // 1.5B ONLY -- deliberately no 7B option here. Measured: 7B through Codex's
    // ~12k-token system prompt timed out after 31.5 min on this machine (unreliable);
    // 1.5B completes the same call in ~6.5 min. If 7B quality is needed, use it via
    // local-code (direct LM Studio, no agentic overhead) instead of through Codex.
    models: ['qwen2.5-coder-1.5b-instruct'],
    modelIds: ['qwen2.5-coder-1.5b-instruct'],
    defaultModel: 'qwen2.5-coder-1.5b-instruct',
    modelFlag: '-m',
    effortFlag: null,
    permissionFlag: '--dangerously-bypass-approvals-and-sandbox',
    autoPermission: true,
    outputFormatFlag: '--json',
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    notes: 'Codex CLI against a LOCAL LM Studio server (127.0.0.1:1234), via `codex exec --oss --local-provider lmstudio`. ' +
      'No cloud account or API key involved. Requires LM Studio running with a model loaded (see scripts/local-ai-start.ps1 / local-ai-status.ps1). ' +
      'Use ONLY when the task genuinely needs tools/repo-edit/shell/tests/repo-search that a direct LM Studio call cannot do -- ' +
      'for everything else (logs, summaries, classification, docs, regex, small code questions, file review, git diff, patch proposals), ' +
      'call LM Studio directly instead (local-fast / local-code / local-review / local-code-review / local-log-analysis) -- it is ~200x faster ' +
      '(~2s vs ~6.5min) because it skips Codex\'s own ~12k-token system prompt entirely. ' +
      'Not for: complex architecture, security-sensitive work, or critical bugs -- escalate to codex/claude cloud for those.',
  },
  'claude-local': {
    models: ['qwen2.5-coder-1.5b-instruct', 'qwen2.5-coder-7b-instruct'],
    modelIds: ['qwen2.5-coder-1.5b-instruct', 'qwen2.5-coder-7b-instruct'],
    defaultModel: 'qwen2.5-coder-1.5b-instruct',
    modelFlag: '--model',
    effortFlag: null,
    permissionFlag: '--dangerously-skip-permissions',
    autoPermission: true,
    outputFormatFlag: '--output-format',
    systemPromptFlag: '--append-system-prompt',
    worktreeFlag: '--worktree',
    extraHeadless: [],
    notes: 'Claude Code CLI against a LOCAL LM Studio server (127.0.0.1:1234), via LM Studio\'s native ' +
      'Anthropic-compatible /v1/messages endpoint. No cloud account or API key involved -- ' +
      'ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN are injected on the spawned process only (spawn-headless.js), ' +
      'never on process.env, so Claude Cloud is unaffected. Requires LM Studio running with the model loaded ' +
      'at 32768+ context (Claude Code\'s own system prompt alone is ~19.8k tokens -- bigger than Codex\'s). ' +
      'Same use-case guidance as codex-oss: logs, tests, docs, repo search, review, small fixes, summaries.',
  },
  jules: {
    models: ['default'],
    modelIds: ['default'],
    defaultModel: 'default',
    modelFlag: null,
    effortFlag: null,
    permissionFlag: null,
    autoPermission: true,
    outputFormatFlag: null,
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    isRemote: true,
    notes: 'Google Jules remote worker (cloud REST API). Requires JULES_API_KEY environment variable.',
  },
  'gemini-api': {
    models: ['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro-preview'],
    modelIds: ['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro-preview'],
    defaultModel: 'gemini-3.5-flash-lite',
    modelFlag: null,
    effortFlag: null,
    permissionFlag: null,
    autoPermission: true,
    outputFormatFlag: null,
    systemPromptFlag: null,
    worktreeFlag: null,
    extraHeadless: [],
    isRemote: true,
    notes: 'Google Gemini Developer API remote worker (cloud REST API). Requires GEMINI_API_KEY environment variable.',
  },
};

// Provider abstraction: launch config, cost tier, idle-detection patterns.
//   tier: 1=basic, 2=mid, 3=premium ; costRank: 1=cheapest .. 5=most expensive
const CLI_CONFIG = {
  claude:      { cmd: 'claude',  label: 'Claude Code', pipeMode: true, tier: 3, costRank: 5, idlePattern: /[❯>]\s*$/ },
  gemini:      { cmd: 'gemini',  label: 'Gemini CLI',  pipeMode: true, tier: 2, costRank: 2, idlePattern: /[❯>$]\s*$/ },
  codex:       { cmd: 'codex',   label: 'Codex CLI',   pipeMode: true, tier: 2, costRank: 3, idlePattern: /[❯>$]\s*$/ },
  antigravity: { cmd: 'agy',     label: 'Antigravity', pipeMode: true, tier: 1, costRank: 1, idlePattern: /[❯>$]\s*$/ },
  copilot:     { cmd: 'copilot', label: 'Copilot CLI', pipeMode: true, tier: 1, costRank: 1, idlePattern: /[❯>]\s*$/ },
  grok:        { cmd: 'grok',    label: 'Grok Code',   pipeMode: true, tier: 2, costRank: 2, idlePattern: /[❯>$]\s*$/ },
  qwen:        { cmd: 'qwen',    label: 'Qwen Code',   pipeMode: true, tier: 2, costRank: 2, idlePattern: /[❯>$]\s*$/ },
  'codex-oss-local': { cmd: 'codex', label: 'Codex OSS (Local · LM Studio)', pipeMode: true, tier: 1, costRank: 0, isLocal: true, idlePattern: /[❯>$]\s*$/ },
  'claude-local': { cmd: 'claude', label: 'Claude Code (Local · LM Studio)', pipeMode: true, tier: 1, costRank: 0, isLocal: true, idlePattern: /[❯>]\s*$/ },
  // Direct LM Studio calls (no CLI process), see spawn-lmstudio.js.
  'lmstudio-qwen-small':  { cmd: null, label: 'Qwen 1.5B (Local · LM Studio)', pipeMode: true, tier: 1, costRank: 0, isLocal: true, isDirectLocal: true, idlePattern: null },
  'lmstudio-qwen-review': { cmd: null, label: 'Qwen 7B review (Local · LM Studio)', pipeMode: true, tier: 1, costRank: 0, isLocal: true, isDirectLocal: true, idlePattern: null },
  jules:       { cmd: null,      label: 'Jules',       pipeMode: true, tier: 2, costRank: 2, isRemote: true, idlePattern: null },
  'gemini-api': { cmd: null,     label: 'Gemini API',  pipeMode: true, tier: 2, costRank: 2, isRemote: true, idlePattern: null },
};

// Cross-model escalation chain (cheapest first); skips circuit-broken / uninstalled CLIs.
// Cloud only: local providers are chosen up-front by the capability-class router
// (task-router.js) and get exactly one attempt; they are never an escalation target.
const ESCALATION_ORDER = ['copilot', 'gemini', 'grok', 'qwen', 'antigravity', 'codex', 'claude'];

module.exports = { HEADLESS_FLAGS, CLI_MODELS, CLI_CONFIG, ESCALATION_ORDER };
