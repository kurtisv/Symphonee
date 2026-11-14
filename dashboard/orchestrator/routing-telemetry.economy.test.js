'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RoutingTelemetry, ROUTES } = require('./routing-telemetry');

test('records taskless local brain answers without saving prompt or response', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-economy-'));
  try {
    const file = path.join(dir, 'routing-telemetry.jsonl');
    const telemetry = new RoutingTelemetry({ file, now: () => Date.parse('2026-11-14T12:00:00Z') });
    const result = {
      source: 'mind-recall', model: 'qwen2.5', tookMs: 47,
      citedNodeIds: ['a', 'b'], answer: 'SENSITIVE ANSWER', prompt: 'SENSITIVE PROMPT',
    };
    const record = telemetry.recordBrainAnswer(result);
    assert.equal(record.route, ROUTES.LOCAL_BRAIN);
    assert.equal(record.citedNodeCount, 2);
    assert.equal(record.cloudUsed, false);
    assert.equal(record.durationMs, 47);
    assert.equal(telemetry.summary().localCompleted, 1);
    assert.equal(telemetry.summary().counts.LOCAL_BRAIN, 1);
    assert.equal(telemetry.recordBrainAnswer({ source: 'escalate' }), null);
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /SENSITIVE/);
    assert.equal(new RoutingTelemetry({ file }).summary().counts.LOCAL_BRAIN, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('existing worker route classifications remain unchanged', () => {
  const telemetry = new RoutingTelemetry();
  const task = { id: 'worker-1', cli: 'lmstudio-qwen-small', selectedProvider: 'lmstudio-qwen-small', state: 'completed', startedAt: 1, completedAt: 10 };
  assert.equal(telemetry.recordTask(task).route, ROUTES.LOCAL_DIRECT);
  assert.equal(telemetry.summary().localCompleted, 1);
  assert.equal(telemetry.summary().counts.LOCAL_BRAIN, 0);
});
