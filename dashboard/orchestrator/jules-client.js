'use strict';
// Google Jules REST API client & Git repository resolver for Symphonee.
// Uses https://jules.googleapis.com/v1alpha with process.env.JULES_API_KEY.
// Secrets (API key) are never logged, exposed, or written to disk.

const { execSync } = require('child_process');

const JULES_API_BASE_URL = 'https://jules.googleapis.com/v1alpha';

/**
 * Parse a GitHub remote URL (HTTPS or SSH) into { owner, repo }.
 * Supports formats like:
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - https://x-access-token:...@github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 *   - git@github.com:owner/repo
 *   - ssh://git@github.com/owner/repo.git
 *   - git://github.com/owner/repo.git
 *
 * @param {string} remoteUrl
 * @returns {{ owner: string, repo: string } | null}
 */
function parseGitHubRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null;
  const trimmed = remoteUrl.trim();
  const regex = /(?:git@github\.com:|https?:\/\/(?:[^@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git:\/\/github\.com\/)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i;
  const match = trimmed.match(regex);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ''),
  };
}

/**
 * Retrieve the git remote origin URL for a working directory.
 *
 * @param {string} cwd
 * @returns {string}
 */
function getGitOriginUrl(cwd) {
  try {
    const url = execSync('git config --get remote.origin.url', {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    if (!url) throw new Error('Remote origin URL is empty');
    return url;
  } catch (err) {
    throw new Error(`Failed to determine git remote origin in "${cwd || process.cwd()}": ${err.message}`);
  }
}

/**
 * Retrieve the current git branch name for a working directory.
 *
 * @param {string} cwd
 * @returns {string}
 */
function getGitBranch(cwd) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    if (!branch || branch === 'HEAD') {
      try {
        const current = execSync('git branch --show-current', {
          cwd: cwd || process.cwd(),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();
        if (current) return current;
      } catch (_) {}
      return 'main';
    }
    return branch;
  } catch (_) {
    return 'main';
  }
}

/**
 * Google Jules REST API Client.
 */
class JulesClient {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.apiKey] - Defaults to process.env.JULES_API_KEY
   * @param {string} [opts.baseUrl] - Defaults to JULES_API_BASE_URL
   * @param {Function} [opts.fetchFn] - Custom fetch implementation for testing
   */
  constructor({ apiKey, baseUrl, fetchFn } = {}) {
    this._apiKey = apiKey || process.env.JULES_API_KEY || '';
    this.baseUrl = (baseUrl || JULES_API_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  get apiKey() {
    return this._apiKey || process.env.JULES_API_KEY || '';
  }

  /**
   * Internal HTTP request helper.
   * Ensures the API key is never exposed in error messages.
   */
  async _request(endpoint, { method = 'GET', body, headers = {}, signal } = {}) {
    const key = this.apiKey;
    if (!key) {
      throw new Error('JULES_API_KEY environment variable is not set. Google Jules requires a valid API key in process.env.JULES_API_KEY.');
    }

    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = endpoint.startsWith('http://') || endpoint.startsWith('https://')
      ? endpoint
      : `${this.baseUrl}${cleanEndpoint}`;

    const reqHeaders = {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
      ...headers,
    };

    const fetchOptions = {
      method,
      headers: reqHeaders,
      signal,
    };
    if (body !== undefined && body !== null) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    let res;
    try {
      res = await this.fetchFn(url, fetchOptions);
    } catch (networkErr) {
      const sanitized = networkErr.message.split(key).join('[REDACTED]');
      throw new Error(`Google Jules API request failed (${method} ${cleanEndpoint}): ${sanitized}`);
    }

    if (!res.ok) {
      let errText = '';
      try {
        const errJson = await res.json();
        errText = errJson.error?.message || JSON.stringify(errJson);
      } catch (_) {
        try {
          errText = await res.text();
        } catch (_) {}
      }
      const sanitized = (errText || `HTTP ${res.status} ${res.statusText}`).split(key).join('[REDACTED]');
      throw new Error(`Google Jules API error (${res.status}): ${sanitized}`);
    }

    if (res.status === 204) return {};

    try {
      return await res.json();
    } catch (_) {
      return {};
    }
  }

  /**
   * List connected sources in Google Jules.
   *
   * @param {Object} [options]
   * @param {number} [options.pageSize]
   * @param {string} [options.pageToken]
   * @returns {Promise<{ sources: Array<Object>, nextPageToken?: string }>}
   */
  async listSources(options = {}) {
    const params = new URLSearchParams();
    if (options.pageSize) params.set('pageSize', String(options.pageSize));
    if (options.pageToken) params.set('pageToken', options.pageToken);

    const qs = params.toString();
    const endpoint = `/sources${qs ? `?${qs}` : ''}`;
    const data = await this._request(endpoint, { method: 'GET' });
    return {
      sources: Array.isArray(data.sources) ? data.sources : [],
      nextPageToken: data.nextPageToken || null,
    };
  }

  /**
   * Find the matching Jules source for a given GitHub repository owner and repo.
   *
   * @param {string} owner
   * @param {string} repo
   * @returns {Promise<Object|null>}
   */
  async findSourceForRepository(owner, repo) {
    if (!owner || !repo) return null;
    const targetOwner = owner.toLowerCase();
    const targetRepo = repo.toLowerCase();
    const targetCombined = `${targetOwner}/${targetRepo}`;

    let pageToken = null;
    const seenPageTokens = new Set();
    do {
      const page = await this.listSources(pageToken ? { pageToken } : {});
      const sources = page.sources;
      for (const s of sources) {
      if (!s) continue;

      // 1. Check s.githubRepo object { owner, repo }
      if (s.githubRepo && typeof s.githubRepo === 'object') {
        const o = (s.githubRepo.owner || s.githubRepo.ownerName || '').toLowerCase();
        const r = (s.githubRepo.repo || s.githubRepo.repositoryName || s.githubRepo.name || '').toLowerCase();
        if (o === targetOwner && r === targetRepo) return s;
      }

      // 2. Check s.githubRepo string e.g. "owner/repo" or "github.com/owner/repo"
      if (typeof s.githubRepo === 'string') {
        const gh = s.githubRepo.toLowerCase().replace(/^github\.com\//, '');
        if (gh === targetCombined) return s;
      }

      // 3. Check s.displayName e.g. "owner/repo"
      if (typeof s.displayName === 'string') {
        const dn = s.displayName.toLowerCase().replace(/^github\.com\//, '');
        if (dn === targetCombined) return s;
      }

      // 4. Check s.name e.g. "sources/github/owner/repo" or "sources/owner/repo"
      if (typeof s.name === 'string') {
        const nameLower = s.name.toLowerCase();
        if (nameLower === `sources/${targetCombined}` || nameLower.endsWith(`/${targetCombined}`)) {
          return s;
        }
      }

      // 5. Check s.repository or s.githubRepoContext
      if (s.repository && typeof s.repository === 'string' && s.repository.toLowerCase().includes(targetCombined)) {
        return s;
      }
      if (s.githubRepoContext?.startingRepo && s.githubRepoContext.startingRepo.toLowerCase().includes(targetCombined)) {
        return s;
      }
      }

      pageToken = page.nextPageToken || null;
      if (pageToken && seenPageTokens.has(pageToken)) break;
      if (pageToken) seenPageTokens.add(pageToken);
    } while (pageToken);

    return null;
  }

  /**
   * Create a new Jules session.
   *
   * @param {Object} opts
   * @param {string} opts.prompt - The prompt/instruction for Jules
   * @param {string|Object} opts.source - Source resource name (e.g. "sources/xyz") or source object
   * @param {string} [opts.startingBranch='main'] - Starting git branch
   * @param {boolean} [opts.requirePlanApproval=false] - Whether Jules should require manual plan approval
   * @returns {Promise<Object>} The created session
   */
  async createSession({ prompt, source, startingBranch = 'main', requirePlanApproval = false }) {
    if (!prompt) throw new Error('Prompt is required to create a Jules session');
    if (!source) throw new Error('Source is required to create a Jules session');

    const sourceName = typeof source === 'object' ? (source.name || source.id) : source;
    if (!sourceName) throw new Error('Valid source name is required');

    const payload = {
      prompt,
      sourceContext: {
        source: sourceName,
        githubRepoContext: {
          startingBranch: startingBranch || 'main',
        },
      },
      requirePlanApproval: Boolean(requirePlanApproval),
    };

    return await this._request('/sessions', {
      method: 'POST',
      body: payload,
    });
  }

  /**
   * Retrieve session state and details.
   *
   * @param {string} sessionId
   * @returns {Promise<Object>}
   */
  async getSession(sessionId) {
    if (!sessionId) throw new Error('sessionId is required');
    const id = sessionId.startsWith('sessions/') ? sessionId : `sessions/${sessionId}`;
    return await this._request(`/${id}`, { method: 'GET' });
  }

  /**
   * List activities for a Jules session.
   *
   * @param {string} sessionId
   * @param {Object} [options]
   * @returns {Promise<{ activities: Array<Object>, nextPageToken?: string }>}
   */
  async listActivities(sessionId, options = {}) {
    if (!sessionId) throw new Error('sessionId is required');
    const id = sessionId.startsWith('sessions/') ? sessionId : `sessions/${sessionId}`;
    const params = new URLSearchParams();
    if (options.pageSize) params.set('pageSize', String(options.pageSize));
    if (options.pageToken) params.set('pageToken', options.pageToken);

    const qs = params.toString();
    const endpoint = `/${id}/activities${qs ? `?${qs}` : ''}`;
    const data = await this._request(endpoint, { method: 'GET' });
    return {
      activities: Array.isArray(data.activities) ? data.activities : [],
      nextPageToken: data.nextPageToken || null,
    };
  }

  /**
   * Poll a session until terminal state or user interaction is required.
   *
   * Terminal / interactive states:
   *   - COMPLETED: done
   *   - FAILED: error
   *   - AWAITING_USER_FEEDBACK: requires user feedback on Jules web UI
   *   - AWAITING_PLAN_APPROVAL: requires plan approval on Jules web UI
   *   - PAUSED: session paused
   *
   * @param {string} sessionId
   * @param {Object} [options]
   * @param {number} [options.pollIntervalMs=3000] - Polling interval in ms
   * @param {number} [options.timeoutMs=0] - Max total wait time (0 = unlimited)
   * @param {Function} [options.onPoll] - Callback `(session, activities) => void`
   * @param {AbortSignal} [options.signal] - AbortSignal to cancel polling
   * @returns {Promise<{ session: Object, activities: Array<Object>, state: string }>}
   */
  async waitForCompletion(sessionId, { pollIntervalMs = 3000, timeoutMs = 0, onPoll = null, signal = null } = {}) {
    const startTime = Date.now();

    while (true) {
      if (signal && signal.aborted) {
        throw new Error('Jules session wait aborted');
      }
      if (timeoutMs > 0 && (Date.now() - startTime) > timeoutMs) {
        throw new Error(`Jules session timed out after ${timeoutMs}ms`);
      }

      const session = await this.getSession(sessionId);
      let activities = [];
      try {
        const actRes = await this.listActivities(sessionId);
        activities = actRes.activities || [];
      } catch (_) {}

      if (typeof onPoll === 'function') {
        try { onPoll(session, activities); } catch (_) {}
      }

      const state = (session.state || 'QUEUED').toUpperCase();

      if (state === 'COMPLETED') {
        return { session, activities, state: 'COMPLETED' };
      }
      if (state === 'FAILED') {
        return { session, activities, state: 'FAILED' };
      }
      if (state === 'AWAITING_USER_FEEDBACK' || state === 'AWAITING_PLAN_APPROVAL') {
        return { session, activities, state };
      }
      if (state === 'PAUSED') {
        return { session, activities, state: 'PAUSED' };
      }

      // Session is in progress (QUEUED, PLANNING, IN_PROGRESS, etc.)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Jules session wait aborted'));
          }, { once: true });
        }
      });
    }
  }
}

/**
 * Automatically resolve GitHub repository remote and Jules source for a given working directory.
 *
 * @param {Object} opts
 * @param {string} [opts.cwd] - Directory to check
 * @param {JulesClient} opts.client - JulesClient instance
 * @returns {Promise<{ owner: string, repo: string, source: Object, branch: string }>}
 */
async function resolveJulesSource({ cwd, client }) {
  const originUrl = getGitOriginUrl(cwd);
  const parsed = parseGitHubRemote(originUrl);
  if (!parsed) {
    throw new Error(`Remote origin "${originUrl}" is not a recognized GitHub repository. Google Jules requires a connected GitHub repository.`);
  }

  const { owner, repo } = parsed;
  const branch = getGitBranch(cwd);

  const source = await client.findSourceForRepository(owner, repo);
  if (!source) {
    throw new Error(`No Jules source found matching repository "${owner}/${repo}". Please make sure "${owner}/${repo}" is connected in Google Jules (https://jules.google.com).`);
  }

  return { owner, repo, source, branch };
}

/**
 * Format session outcome and activities into a structured, readable Markdown result.
 *
 * @param {Object} opts
 * @param {Object} opts.session
 * @param {Array<Object>} [opts.activities]
 * @param {string} [opts.owner]
 * @param {string} [opts.repo]
 * @param {string} [opts.branch]
 * @param {string} [opts.julesUrl]
 * @returns {string}
 */
function formatJulesResult({ session, activities = [], owner, repo, branch, julesUrl }) {
  const rawId = (session?.name || session?.id || '').replace(/^sessions\//, '');
  const displayId = session?.name || session?.id || 'Unknown';
  const state = session?.state || 'UNKNOWN';
  const url = julesUrl || (rawId ? `https://jules.google.com/session/${rawId}` : 'https://jules.google.com');

  const lines = [
    `# Google Jules Session Result`,
    ``,
    `- **Status**: \`${state}\``,
    `- **Session ID**: \`${displayId}\``,
    `- **Jules Link**: [Open session in Google Jules](${url})`,
  ];

  if (owner && repo) {
    lines.push(`- **Repository**: \`${owner}/${repo}\` (branch: \`${branch || 'main'}\`)`);
  }
  lines.push('');

  if (session?.title) {
    lines.push(`## ${session.title}`, '');
  }

  if (state === 'AWAITING_USER_FEEDBACK' || state === 'AWAITING_PLAN_APPROVAL') {
    lines.push(
      `> [!IMPORTANT]`,
      `> **Action Required**: Jules is currently in state **${state}**.`,
      `> Please [open the Jules session](${url}) in your browser to review the plan or provide feedback.`,
      ''
    );
  }

  const summary = extractJulesSummary(session, activities);
  if (summary) {
    lines.push(`## Summary`, '', String(summary).trim(), '');
  } else {
    lines.push(
      `## Summary`,
      '',
      `Jules reported a terminal state but did not return a textual result. Review the activity log or reopen the Jules session for the full output.`,
      ''
    );
  }

  if (session?.artifacts && session.artifacts.length > 0) {
    lines.push(`## Artifacts`, '');
    for (const art of session.artifacts) {
      const artTitle = art.title || art.name || 'Artifact';
      const artDesc = art.description ? `: ${art.description}` : '';
      lines.push(`- **${artTitle}**${artDesc}`);
      if (art.uri || art.url) {
        lines.push(`  Link: ${art.uri || art.url}`);
      }
    }
    lines.push('');
  }

  if (session?.changeSet) {
    lines.push(`## Change Set`, '');
    if (session.changeSet.gitPatch) {
      lines.push('```diff', session.changeSet.gitPatch, '```', '');
    } else if (session.changeSet.pullRequestUrl) {
      lines.push(`- **Pull Request**: [${session.changeSet.pullRequestUrl}](${session.changeSet.pullRequestUrl})`, '');
    } else {
      lines.push('```json', JSON.stringify(session.changeSet, null, 2), '```', '');
    }
  }

  if (activities && activities.length > 0) {
    lines.push(`## Activity Log (${activities.length})`, '');
    for (const act of activities) {
      const time = act.createTime ? new Date(act.createTime).toLocaleTimeString() : '';
      const type = act.type || act.kind || 'Activity';
      const desc = extractActivityText(act) || act.name || '';
      lines.push(`- **[${time || type}]** ${desc}`);
    }
    lines.push('');
  }

  if (session?.error) {
    lines.push(`## Error Details`, '');
    const errMsg = session.error.message || JSON.stringify(session.error);
    lines.push('```', errMsg, '```', '');
  }

  return lines.join('\n');
}

// Jules has returned the final answer in several payload shapes over time.
// Keep the adapter permissive, but only promote textual fields to Summary so
// IDs, timestamps and opaque API objects never become a fake report.
function extractJulesSummary(session, activities = []) {
  const direct = firstText(session, ['output', 'result', 'summary', 'description']);
  if (direct) return direct;

  const preferred = [...activities].reverse()
    .map((activity) => firstText(activity, ['agentMessage', 'agent_message', 'finalMessage', 'final_message', 'output', 'result', 'content', 'message', 'text', 'data', 'payload', 'event']))
    .find(Boolean);
  if (preferred) return preferred;

  const fallback = [...activities].reverse()
    .map((activity) => firstText(activity, ['description', 'summary']))
    .find((text) => text && text.trim().length >= 24);
  return fallback || '';
}

function extractActivityText(activity) {
  return firstText(activity, [
    'agentMessage', 'agent_message', 'finalMessage', 'final_message',
    'output', 'result', 'content', 'message', 'text', 'description', 'summary', 'data', 'payload', 'event',
  ]) || '';
}

function firstText(value, keys, seen = new Set()) {
  if (value == null || seen.has(value)) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';
  seen.add(value);

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    const nested = firstText(candidate, keys, seen);
    if (nested) return nested;
  }
  return '';
}

module.exports = {
  JULES_API_BASE_URL,
  JulesClient,
  parseGitHubRemote,
  getGitOriginUrl,
  getGitBranch,
  resolveJulesSource,
  formatJulesResult,
};
