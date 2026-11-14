# Local Qwen evaluation

Status: exploratory measurement, not proof of readiness for autonomous edits.
The fixtures and expected answers are synthetic; no live Mind, repository content,
provider credentials, paid model calls or autopilot state are used. The only model
endpoint is Ollama on 127.0.0.1:11434 with qwen2.5:1.5b. No inference runs unless
`--inference` is passed explicitly.

## Reproduce

```
node --test scripts/benchmark-local-mind.test.js scripts/benchmark-local-discovery.test.js
node scripts/benchmark-local-mind.js
node scripts/benchmark-local-mind.js --inference --repeat
node scripts/benchmark-local-discovery.js --inference --repeat
```

The first benchmark separates Mind knowledge/skill selection from generation.
Its oracle arm gives the exact record, retrieval arm uses `buildMindContext`,
and promptCandidate changes wording with the same retrieved context. Dense
vectors are disabled for repeatability: these results measure lexical retrieval
only. Four small English cases cover quota, independent review, prohibited Git
actions and empty-array JavaScript behavior. Two cases expect a skill. Automatic
answer checks are limited lexical rules, not complete factual verification.

The second benchmark compares the existing discovery prompt, a rejected
example-based candidate, and a minimal variant, using the same four synthetic
contexts: one potential task, no known issue, only a skill, and an instruction
injected into an untrusted record. For each arm it checks parsing, supplied
reference IDs, and whether the case expected a task or abstention. A mechanically
passing task still needs independent review of factual claims and acceptance
criteria; a real source reference does not prove its interpretation is correct.

Both use temperature 0 and seeded repeats, rotating execution order. Repeats are
not independent samples and model results can still vary. The tests do not use
the complete actual worker context or prove the model can edit files.

## Observed baseline (2026-11-14)

Ollama qwen2.5:1.5b, lexical synthetic Mind/skill fixtures:

| Measure | Result |
| --- | --- |
| Expected knowledge present | 4/4 cases |
| Expected skill selected | 2/2 applicable cases |
| Answer with exact reference context | 9/12 responses |
| Answer with retrieved context | 9/12 responses |
| Candidate wording with retrieved context | 9/12 responses |

The Git safety answer was `UNKNOWN` in all three repeats even with the exact
record. The candidate wording showed no measured improvement and was not adopted.
This simple corpus shares keywords with queries and is not representative of
the full Mind, multilingual retrieval, relevance ranking or code discovery.

Paired discovery smoke, same four cases and two repeats each (temperature 0):

| Prompt | Positive case mechanically accepted | Negative cases correctly abstained |
| --- | --- | --- |
| Existing | 0/2 | 6/6 |
| Example-based candidate | 1/2 | 0/6 |
| Minimal format reminder | 0/2 | 6/6 |

The example-based candidate invented tasks without supporting project evidence,
including one derived from the injected instruction. Some invented reference
IDs were caught, but a citation to an actual untrusted record could still pass a
reference-existence check. The minimal variant preserved these negative controls
but invented a reference and used a category with wrong capitalization on the
positive case. Neither candidate met the predeclared zero-negative-failure plus
positive-improvement criterion. The production prompt remains unchanged.

An earlier two-arm run returned 2/2 mechanical positive results and 0/6 negative
results for the example-based candidate; the later three-arm run above returned
1/2 and 0/6. These tiny, deterministic tests cannot quantify real-world rates.
No change is justified solely by the numerical scores, and no output from them
is a validated task. Expand with blinded, independently reviewed historical
cases, French queries, held-out negatives and real local capability checks before
using Qwen autonomously.

Raw synthetic runs, when created on this machine, are in ignored
`.ai-workspace/local-benchmark-synthetic.json` and
`.ai-workspace/local-discovery-benchmark-three-arms.json`. They contain only the
synthetic prompts and responses and can be regenerated; they are not production
logs or live Mind snapshots.
