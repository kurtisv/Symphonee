'use strict';
// PROPOSAL ONLY. Checker profiles for measuring general skill without silently weakening
// the security checker.
//
// `strict` is what runs today (qwen-pure-assertions.js, untouched: changing that file changes
// CHECKER_VERSION and retires every lesson). `extended-experimental` documents constructs a
// 4B developer naturally uses and that the strict profile refuses (observed in the memory
// experiment: spread `Math.min(...v)`, reduce callbacks with block bodies, counting loops).
// It is NOT implemented, NOT selectable, and can never apply to a real project: it exists so
// a future, separately reviewed, isolated interpreter can be benchmarked beside the strict one.
// Lessons validated under one profile must never be recalled under another.
const PROFILES = Object.freeze({
  strict: Object.freeze({ id: 'strict', active: true, implemented: true, realProjects: false, // Qwen stays locked for real projects whatever the profile
    allows: Object.freeze(['const', 'index', 'length', 'reduce', 'Math.abs', 'Math.max', 'Math.min', 'conditional', 'logical', 'comparison', 'arithmetic']) }),
  'extended-experimental': Object.freeze({ id: 'extended-experimental', active: false, implemented: false, realProjects: false,
    allows: Object.freeze(['const', 'index', 'length', 'reduce', 'Math.abs', 'Math.max', 'Math.min', 'conditional', 'logical', 'comparison', 'arithmetic', 'spread-in-Math.min/max', 'reduce-block-body']),
    requirements: Object.freeze(['a separate interpreter with its own CHECKER_VERSION', 'its own lessons namespace', 'only fictional fixtures', 'a security review before any use', 'explicit user activation']) }),
});
const activeProfile = () => PROFILES.strict;
// Fails closed: anything but the strict profile is refused.
function select(id) { if (id !== 'strict') throw new Error('Checker profile "' + id + '" is a proposal and cannot be selected'); return PROFILES.strict; }
module.exports = { PROFILES, activeProfile, select };
