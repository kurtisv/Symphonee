'use strict';

const DEFAULT_MAX = 6000;
const SECRET_KEY = /(api.?key|token|secret|password|pat|credential|authorization|bearer)/i;
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, redact(v)]));
  return typeof value === 'string' ? value.replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})/g, '[REDACTED]') : value;
}
function createContextPacket(input = {}, maxChars = DEFAULT_MAX) {
  const packet = redact({ taskGoal: input.taskGoal, originalPrompt: input.originalPrompt, completedWork: input.completedWork, findings: input.findings, changedFiles: input.changedFiles, tests: input.tests, errors: input.errors, nextAction: input.nextAction, gitDiffSummary: input.gitDiffSummary, relevantArtifacts: input.relevantArtifacts });
  let json = JSON.stringify(packet, null, 2);
  if (json.length > maxChars) { packet.findings = Array.isArray(packet.findings) ? packet.findings.slice(0, 8) : packet.findings; packet.errors = Array.isArray(packet.errors) ? packet.errors.slice(0, 5) : packet.errors; packet.relevantArtifacts = Array.isArray(packet.relevantArtifacts) ? packet.relevantArtifacts.slice(0, 10) : packet.relevantArtifacts; json = JSON.stringify(packet, null, 2); }
  if (json.length > maxChars) json = json.slice(0, Math.max(0, maxChars - 32)) + '\n  "truncated": true\n}';
  return json;
}
module.exports = { createContextPacket, redact, DEFAULT_MAX };
