// mind-ui :: latest-request guard. Each start() returns a ticket; only the most
// recent ticket is current, so an older answer (success or error) is dropped
// even when the same view was selected again in between (A -> B -> A).
export function makeLatest() {
  let seq = 0;
  return {
    start() { const ticket = ++seq; return () => ticket === seq; },
    invalidate() { seq++; },
  };
}
