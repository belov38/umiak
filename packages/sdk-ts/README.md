# TypeScript SDK

Windows 11 uses the single `windows` template and includes the desktop (4gb by default; 8gb optional). Linux offers Ubuntu 26.04 (`linux`, default), Debian 13 (`debian`), and Ubuntu desktop (`linux-desktop`). The legacy `windows-desktop` slug remains an input alias of `windows`; API responses return `windows`. Existing headless Windows sandboxes and saved snapshots retain their retired build until deleted.

```ts
import { Umiak } from "@umiak/sdk";

const umiak = new Umiak();
const sandbox = await umiak.sandboxes.create({ template: "windows", size: "4gb" });
```

Capacity waits (0..604800 seconds, default fail immediately):

```ts
await sandbox.resume({ capacityWaitSeconds: 6000 }, { wait: true });
const queued = await umiak.sandboxes.create({ capacityWaitSeconds: 6000 });
await queued.cancelStart(); // while still queued
```

Readiness waits add the capacity budget unless `waitTimeoutMs` is explicit.
Disconnecting does not cancel the server ticket. Inspect `state` and
`activeOperation.progress` for queued progress. Timeout preserves
retryable `out_of_capacity`.
