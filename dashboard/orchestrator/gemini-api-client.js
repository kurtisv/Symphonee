'use strict';
// Google Gemini Developer API Client for Symphonee Orchestrator.
// Uses https://generativelanguage.googleapis.com/v1beta/interactions with process.env.GEMINI_API_KEY.
// Secrets (API key) are never logged, exposed, or written to disk.

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_INTERACTIONS_URL = `${GEMINI_API_BASE_URL}/interactions`;

/**
 * Google Gemini Developer API Client.
 */
class GeminiApiClient {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.apiKey] - Defaults to process.env.GEMINI_API_KEY
   * @param {string} [opts.baseUrl] - Defaults to GEMINI_API_BASE_URL
   * @param {Function} [opts.fetchFn] - Custom fetch implementation for testing
   */
  constructor({ apiKey, baseUrl, fetchFn } = {}) {
    this._apiKey = apiKey !== undefined ? apiKey : (process.env.GEMINI_API_KEY || '');
    this.baseUrl = (baseUrl || GEMINI_API_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = fetchFn || globalThis.fetch;
  }

  get apiKey() {
    return this._apiKey !== undefined && this._apiKey !== ''
      ? this._apiKey
      : (process.env.GEMINI_API_KEY || '');
  }

  /**
   * Internal HTTP request helper.
   * Ensures the API key is never exposed in error messages or logs.
   */
  async _request(endpoint, { method = 'POST', body, headers = {}, signal } = {}) {
    const key = this.apiKey;
    if (!key) {
      throw new Error('GEMINI_API_KEY environment variable is not set. Gemini API remote worker requires a valid API key in process.env.GEMINI_API_KEY.');
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
      throw new Error(`Google Gemini API request failed (${method} ${cleanEndpoint}): ${sanitized}`);
    }

    if (!res.ok) {
      let errText = '';
      try {
        const errJson = await res.json();
        errText = errJson.error?.message || (typeof errJson.error === 'string' ? errJson.error : JSON.stringify(errJson));
      } catch (_) {
        try {
          errText = await res.text();
        } catch (_) {}
      }
      const sanitized = (errText || `HTTP ${res.status} ${res.statusText}`).split(key).join('[REDACTED]');
      throw new Error(`Google Gemini API error (${res.status}): ${sanitized}`);
    }

    if (res.status === 204) return {};

    try {
      return await res.json();
    } catch (_) {
      return {};
    }
  }

  /**
   * Create an interaction with Google Gemini Developer API.
   *
   * @param {Object} opts
   * @param {string|Object} opts.prompt - The prompt or input content
   * @param {string} [opts.model='gemini-3.5-flash-lite'] - Model identifier
   * @param {string|Object} [opts.systemInstruction] - Optional system instruction
   * @param {string|number} [opts.thinkingLevel] - Optional thinking configuration level
   * @param {AbortSignal} [opts.signal] - Abort signal
   * @param {number} [opts.timeout] - Request timeout in milliseconds
   * @returns {Promise<Object>} The API interaction response
   */
  async createInteraction({ prompt, model = 'gemini-3.5-flash-lite', systemInstruction, thinkingLevel, signal, timeout } = {}) {
    if (!prompt) {
      throw new Error('Prompt is required to create a Gemini interaction');
    }

    const payload = {
      model: model || 'gemini-3.5-flash-lite',
      input: prompt,
    };

    if (systemInstruction) {
      payload.system_instruction = systemInstruction;
    }
    if (thinkingLevel !== undefined && thinkingLevel !== null) {
      payload.thinking_level = thinkingLevel;
    }

    let requestSignal = signal;
    let timeoutController = null;
    let timeoutId = null;
    if (Number.isFinite(timeout) && timeout > 0) {
      timeoutController = new AbortController();
      timeoutId = setTimeout(() => timeoutController.abort(), timeout);
      if (signal) {
        if (signal.aborted) timeoutController.abort();
        else signal.addEventListener('abort', () => timeoutController.abort(), { once: true });
      }
      requestSignal = timeoutController.signal;
    }
    try {
      return await this._request('/interactions', {
        method: 'POST',
        body: payload,
        signal: requestSignal,
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Extract useful generated text from a Gemini API interaction response.
   *
   * @param {Object} response
   * @returns {string}
   */
  extractText(response) {
    if (!response || typeof response !== 'object') return '';

    // 1. Direct outputs array (Interactions API canonical format)
    if (Array.isArray(response.outputs)) {
      const parts = [];
      for (const item of response.outputs) {
        if (typeof item === 'string') {
          parts.push(item);
        } else if (item && typeof item === 'object') {
          if (typeof item.text === 'string') {
            parts.push(item.text);
          } else if (typeof item.content === 'string') {
            parts.push(item.content);
          } else if (Array.isArray(item.parts)) {
            for (const part of item.parts) {
              if (typeof part === 'string') parts.push(part);
              else if (part && typeof part.text === 'string') parts.push(part.text);
            }
          }
        }
      }
      if (parts.length > 0) return parts.join('\n').trim();
    }

    // 2. Single output field
    if (response.output !== undefined && response.output !== null) {
      if (typeof response.output === 'string') return response.output.trim();
      if (typeof response.output === 'object') {
        if (typeof response.output.text === 'string') return response.output.text.trim();
        if (typeof response.output.content === 'string') return response.output.content.trim();
      }
    }

    // 3. Candidates format (GenerateContent fallback compatibility)
    if (Array.isArray(response.candidates) && response.candidates.length > 0) {
      const cand = response.candidates[0];
      if (cand && cand.content && Array.isArray(cand.content.parts)) {
        const texts = cand.content.parts
          .map(p => (typeof p === 'string' ? p : p?.text || ''))
          .filter(Boolean);
        if (texts.length > 0) return texts.join('\n').trim();
      }
    }

    // 4. Fallback root-level text / content properties
    if (typeof response.text === 'string') return response.text.trim();
    if (typeof response.content === 'string') return response.content.trim();
    if (typeof response.response === 'string') return response.response.trim();
    if (typeof response.result === 'string') return response.result.trim();

    return '';
  }

  /**
   * Extract standardized usage metadata from a Gemini API interaction response.
   *
   * @param {Object} response
   * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number, cachedTokens: number, thoughtTokens: number }}
   */
  extractUsage(response) {
    if (!response || typeof response !== 'object') {
      return {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        thoughtTokens: 0,
      };
    }

    const inputTokens = response.total_input_tokens
      ?? response.usage?.total_input_tokens
      ?? response.usageMetadata?.promptTokenCount
      ?? response.usage?.inputTokens
      ?? response.usage?.promptTokens
      ?? 0;

    const outputTokens = response.total_output_tokens
      ?? response.usage?.total_output_tokens
      ?? response.usageMetadata?.candidatesTokenCount
      ?? response.usage?.outputTokens
      ?? response.usage?.completionTokens
      ?? 0;

    const totalTokens = response.total_tokens
      ?? response.usage?.total_tokens
      ?? response.usageMetadata?.totalTokenCount
      ?? response.usage?.totalTokens
      ?? (Number(inputTokens) + Number(outputTokens));

    const cachedTokens = response.total_cached_tokens
      ?? response.usage?.total_cached_tokens
      ?? response.usageMetadata?.cachedContentTokenCount
      ?? response.usage?.cachedTokens
      ?? 0;

    const thoughtTokens = response.total_thought_tokens
      ?? response.usage?.total_thought_tokens
      ?? response.usageMetadata?.candidatesBillableReasoningTokenCount
      ?? response.usage?.thoughtTokens
      ?? 0;

    return {
      inputTokens: Number(inputTokens) || 0,
      outputTokens: Number(outputTokens) || 0,
      totalTokens: Number(totalTokens) || 0,
      cachedTokens: Number(cachedTokens) || 0,
      thoughtTokens: Number(thoughtTokens) || 0,
    };
  }
}

module.exports = {
  GEMINI_API_BASE_URL,
  GEMINI_INTERACTIONS_URL,
  GeminiApiClient,
};
