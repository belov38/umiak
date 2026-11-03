# TypeScript SDK

Windows 11 uses the single `windows` template and includes the desktop (4gb by default; 8gb optional). Linux offers `linux` and `linux-desktop`. The legacy `windows-desktop` slug remains an input alias of `windows`; API responses return `windows`. Existing headless Windows sandboxes and saved snapshots retain their retired build until deleted.

```ts
import { Umiak } from "@umiak/sdk";

const umiak = new Umiak();
const sandbox = await umiak.sandboxes.create({ template: "windows", size: "4gb" });
```
