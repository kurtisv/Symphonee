'use strict';
// Experimental separate-process entry point. The candidate source is parsed
// and interpreted by a restricted evaluator, never loaded or executed by Node.
const { runPureAssertions } = require('./qwen-pure-assertions');
if (require('node:v8').getHeapStatistics().heap_size_limit > 320 * 1024 * 1024) {
  process.stderr.write('bounded V8 heap required\n');
  process.exit(2);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 300000) { process.stderr.write('input limit\n'); process.exit(2); }
});
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(input);
    const count = runPureAssertions(request.sources, request.cases);
    process.stdout.write(JSON.stringify({ ok:true, expected:request.cases.length, executed:count }) + '\n');
  } catch (error) {
    process.stderr.write('verification refused: ' + String(error.message || error).slice(0,200) + '\n');
    process.exitCode = 1;
  }
});
