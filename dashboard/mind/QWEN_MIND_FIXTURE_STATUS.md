# Qwen Mind experiment: NO-GO

The fixture controller writes experimental artifacts to isolated fixture spaces
using the existing Mind graph store. It never promotes simulated reviews.
This is not enabled for real projects.

The 2026-11-14 isolated real-store probe observed a process killed after a
graph write, recovered its queued event, and read it in a fresh process. Four
parallel fixture writers produced two immediate successes and two retries;
after draining the queue, each event was present exactly once. An earlier run
without fixture exclusion lost events despite four successful exits.

The fixture-only hard-link lock does not coordinate generic Mind writers. A
crash while recovering a stale lock can leave a .reaper file and block future
recovery. Queue insertion uses a complete synced temporary file followed by an
atomic hard link; abandoned temporary files are ignored, not replayed. The
graph store does not establish physical durability before queue deletion, so
read-back and process-crash recovery are not proof against power failure.
Fixture space naming and supplied paths do not attest isolation by themselves.

Recall currently requires an explicit experiment identifier; verified lesson
retrieval returns no lessons. The available local-model comparison involved
one task per arm, insufficient for a meaningful general performance claim.
No review from a simulated supervisor can certify a lesson.

Before any GO: coordinate all writers of the tested space, make recovery
resilient to failure during recovery, establish durable write-ahead replay and
storage barriers, attest fixture isolation, implement bounded relevance-based
retrieval of certified lessons, and repeat adversarial and multi-task tests.
The unrelated supervisor pause document and the real-project lock remain in force.
