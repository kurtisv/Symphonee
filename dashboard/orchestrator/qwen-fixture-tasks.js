'use strict';
// Fictional JavaScript tasks shared by the model evaluation and the autopilot
// fixture harness. Requirements and two visible examples are shown to the
// developer; every case is checked by the host. `stress` (optional) compares the
// final code with a host reference on many more inputs, in an offline container.
const MAX = 1.7976931348623157e308;
const c = (fn, args, expected) => ({ fn, args, expected });

// Deterministic generator: the same inputs on every run.
function rng(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

const TASKS = [
  { id: 'clamp', fn: 'clamp', params: 'x, lo, hi', level: 'easy',
    req: 'clamp(x, lo, hi): return lo when x < lo, hi when x > hi, otherwise x. If lo > hi the bounds are invalid: return null.',
    show: [c('clamp', [5, 0, 10], 5), c('clamp', [-3, 0, 10], 0)],
    cases: [c('clamp', [5, 0, 10], 5), c('clamp', [-3, 0, 10], 0), c('clamp', [12, 0, 10], 10), c('clamp', [0, 0, 10], 0), c('clamp', [10, 0, 10], 10), c('clamp', [1, 5, 2], null), c('clamp', [-7, -9, -8], -8)] },
  { id: 'leap', fn: 'isLeapYear', params: 'y', level: 'easy',
    req: 'isLeapYear(y): Gregorian rule. A year is a leap year if it is divisible by 4, except years divisible by 100, which are leap years only if also divisible by 400. Return true or false.',
    show: [c('isLeapYear', [2024], true), c('isLeapYear', [2023], false)],
    cases: [c('isLeapYear', [2024], true), c('isLeapYear', [2023], false), c('isLeapYear', [1900], false), c('isLeapYear', [2000], true), c('isLeapYear', [2100], false), c('isLeapYear', [2400], true), c('isLeapYear', [4], true)],
    stress: { args: () => Array.from({ length: 4000 }, (_, i) => [i + 1]), ref: ([y]) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) } },
  { id: 'fizz', fn: 'fizzBuzz', params: 'n', level: 'easy',
    req: 'fizzBuzz(n) for a positive integer n: return "FizzBuzz" if n is divisible by 15, "Fizz" if divisible by 3, "Buzz" if divisible by 5, otherwise the number as a string (for example "7").',
    show: [c('fizzBuzz', [9], 'Fizz'), c('fizzBuzz', [7], '7')],
    cases: [c('fizzBuzz', [9], 'Fizz'), c('fizzBuzz', [7], '7'), c('fizzBuzz', [15], 'FizzBuzz'), c('fizzBuzz', [30], 'FizzBuzz'), c('fizzBuzz', [10], 'Buzz'), c('fizzBuzz', [1], '1'), c('fizzBuzz', [98], '98')] },
  { id: 'max', fn: 'maxOf', params: 'v', level: 'medium',
    req: 'maxOf(v) for an array of finite numbers: return null for an empty array, otherwise the largest element. Arrays may contain only negative numbers.',
    show: [c('maxOf', [[3, -1, 7]], 7), c('maxOf', [[]], null)],
    cases: [c('maxOf', [[3, -1, 7]], 7), c('maxOf', [[]], null), c('maxOf', [[-5, -2, -9]], -2), c('maxOf', [[4]], 4), c('maxOf', [[0, 0]], 0), c('maxOf', [[-1e300, -1e301]], -1e300), c('maxOf', [[2, 9, 9, 1]], 9)],
    stress: { args: () => { const r = rng(11); return Array.from({ length: 2000 }, () => [Array.from({ length: Math.floor(r() * 10) }, () => Math.round((r() * 2 - 1) * 1e6) / (r() < 0.5 ? 1 : 1000))]); },
      ref: ([v]) => v.length ? v.reduce((m, x) => x > m ? x : m, v[0]) : null } },
  { id: 'countpos', fn: 'countPositive', params: 'v', level: 'medium',
    req: 'countPositive(v) for an array of finite numbers: return how many elements are strictly greater than zero (0 for an empty array).',
    show: [c('countPositive', [[1, -2, 3, 0]], 2), c('countPositive', [[]], 0)],
    cases: [c('countPositive', [[1, -2, 3, 0]], 2), c('countPositive', [[]], 0), c('countPositive', [[-1, -2]], 0), c('countPositive', [[0, 0, 0]], 0), c('countPositive', [[5]], 1), c('countPositive', [[1e-300, 2, -3]], 2)] },
  { id: 'average', fn: 'average', params: 'v', level: 'hard',
    req: 'average(v) for an array of finite numbers: return null for an empty array, otherwise the arithmetic mean. It must never return Infinity or -Infinity when the mean itself is a finite double, even for arrays of very large values close to the largest double (intermediate sums must not overflow, including through rounding). Ordinary rounding error, cancellation error and underflow of tiny values are acceptable.',
    show: [c('average', [[1, 2, 3]], 2), c('average', [[]], null)],
    cases: [c('average', [[1, 2, 3]], 2), c('average', [[]], null), c('average', [[-2, 2]], 0), c('average', [[4, 6]], 5), c('average', [[MAX, MAX]], MAX), c('average', [[MAX, MAX, MAX]], MAX), c('average', [[-MAX, -MAX, -MAX]], -MAX)] },
];

module.exports = { MAX, c, TASKS, rng };
