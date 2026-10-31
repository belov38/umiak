# Pinned wire fixtures

Source-derived fixtures, not a claim of a live pve recording. Fields irrelevant to
our parser are omitted. Fake HTTP servers replay these bytes; live captures will
be compared during the pve spike.

- Sunshine v2026.914.233613, commit 63d35f702ee9e362e43263742981836ec0710384:
  `src/confighttp.cpp` password/pin/apps-close handlers;
  `src/stream.cpp` lines776/779 ENet CONNECT/DISCONNECT logs.
- moonlight-web v3.0.1, commit 922c2e155d1d76b84932c42491f7c973509bfe29:
  `src/api/bindings.rs`, `src/api/host.rs`, `src/api/response_streaming.rs`.
  Pair is newline-delimited JSON: Pin first, Paired after Sunshine handshake.

Sources:
https://github.com/LizardByte/Sunshine/tree/v2026.914.233613
https://github.com/MrCreativ3001/moonlight-web-stream/tree/v3.0.1
