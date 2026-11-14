// Server timestamps order HTTP and WebSocket observations independently per pilot.
export function createSnapshotStore() {
  const values = new Map();
  const stamp = value => typeof value === 'number' ? value : Date.parse(value) || 0;
  return {
    get: pilot => values.get(pilot),
    accept(snapshot) {
      if (!snapshot || !snapshot.pilot) return false;
      const previous = values.get(snapshot.pilot);
      if (previous && stamp(snapshot.updatedAt) < stamp(previous.updatedAt)) return false;
      values.set(snapshot.pilot, snapshot);
      return true;
    },
  };
}
