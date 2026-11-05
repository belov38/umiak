# S26a: cold create only

Remove warm selection (including the capacity wait queue), eviction, failFast,
pool retry, production, metrics and config targets. Keep cold provisioning,
token rotation and agent claim with environment/credential delivery.

Keep legacy storage and states: no SQL schema change or migration. Unallocated
legacy pool rows are quarantined, counted in RAM and reported by `node ram`;
never automatically provision or delete them. Old queued eviction deletes and
releasing leases are quarantined too; explicit `machine delete` clears the pool
marker and queues teardown. Allocated legacy claiming machines
may finish. Persisted operation JSON is an open record; old fromPool/failFast
keys deserialize and are ignored. Preserve the pool_ready guest protocol as the
cold boot readiness signal.

Keep deprecated PoolTarget export until S24 drops the Payload reader import.
Do not edit Payload, web, or S24 config imports. Validate with Vitest, Biome,
and typecheck; push s26a-no-warm-pools without merging or live host checks.
