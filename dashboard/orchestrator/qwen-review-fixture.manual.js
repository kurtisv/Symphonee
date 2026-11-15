'use strict';
// Manual, subscription-backed fixture only; not part of the automatic suite.
require('./qwen-supervision').runInfinityFixtureReview().then(result=>{
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.review.decision!=='NO-GO') process.exitCode=2;
}).catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;});
