'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { supervisionDecision, digest, contextDigest, parseReviewResponse, runInfinityFixtureReview } = require('./qwen-supervision');
const diff = 'proposed diff';
const context = {baseCommit:'a'.repeat(40),workspaceId:'fictional',requirementsHash:digest('requirements'),assertionsHash:digest('assertions')};
const item = () => ({ attempt:1, diff, context:{...context}, review:{provider:'codex',author:'qwen',diffHash:digest(diff),contextHash:contextDigest(context,1),decision:'pass'}, technical:{diffHash:digest(diff),contextHash:contextDigest(context,1),passed:true,expected:3,executed:3} });
const trust = {verifyReview:async()=>true,verifyTechnical:async()=>true};
test('real reviewer fixture remains blocked while process containment is unverified', async () => {
  await assert.rejects(runInfinityFixtureReview(), /process containment is not verified/);
});
test('structured response must match its fresh host-created request', () => {
  const request={requestId:'a'.repeat(32),diffHash:digest('diff'),contextHash:digest('context'),expiresAt:1000};
  const response={requestId:request.requestId,diffHash:request.diffHash,contextHash:request.contextHash,decision:'GO',corrections:[]};
  assert.deepEqual(parseReviewResponse(JSON.stringify(response),request,999),response);
  for (const bad of ['', '{}', JSON.stringify({...response,diffHash:digest('other')}), JSON.stringify({...response,requestId:'b'.repeat(32)}), JSON.stringify({...response,decision:'NO-GO'}), JSON.stringify({...response,extra:1})]) assert.throws(()=>parseReviewResponse(bad,request,999));
  assert.throws(()=>parseReviewResponse(JSON.stringify(response),request,1001));
  assert.throws(()=>parseReviewResponse(JSON.stringify({...response,corrections:['security flaw']}),request,999));
  assert.equal(parseReviewResponse(JSON.stringify({...response,decision:'NO-GO',corrections:['Fix the incorrect result']}),request,999).decision,'NO-GO');
});
test('never proceeds without both independently verified attestations', async () => {
  assert.equal((await supervisionDecision(item())).decision,'blocked');
  assert.equal((await supervisionDecision(item(),{...trust,verifyTechnical:async()=>false})).decision,'blocked');
  const wrong=item(); wrong.review.provider='qwen'; assert.equal((await supervisionDecision(wrong,trust)).decision,'blocked');
  const stale=item(); stale.review.diffHash=digest('other'); assert.equal((await supervisionDecision(stale,trust)).decision,'blocked');
  const differentContext=item(); differentContext.context.workspaceId='another'; assert.equal((await supervisionDecision(differentContext,trust)).decision,'blocked');
  const missed=item(); missed.technical.executed=2; assert.equal((await supervisionDecision(missed,trust)).decision,'blocked');
  assert.equal((await supervisionDecision(item(),trust)).decision,'eligible-for-human-review');
});
test('independent rejection permits at most three attempts', async () => {
  const x=item(); x.review.decision='fail';
  x.technical.passed=false;
  assert.equal((await supervisionDecision(x,trust)).decision,'retry');
  assert.equal((await supervisionDecision(x,{verifyReview:async()=>true})).decision,'retry');
  x.attempt=3; x.review.contextHash=contextDigest(x.context,3); assert.equal((await supervisionDecision(x,trust)).decision,'stop');
  x.attempt=4; assert.equal((await supervisionDecision(x,trust)).decision,'blocked');
});
