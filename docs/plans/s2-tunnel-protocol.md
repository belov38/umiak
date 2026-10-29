# S2 Tunnel Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the S2 contract and shared parts: `sbx.tunnel.v1` proto, a Go tunnel library (agent client, gateway acceptor, registry, drain, reverse proxy) and the TS `@sbx/agent-client`, verified with an in-memory transport with fault injection and a `Process` test double.

**Architecture:** One Go module `libs/tunnel` holds everything shared by the guest agent (S3) and the gateway binary (S4): transport interfaces, a WebSocket transport and an in-memory one, the agent-side client (HTTP/2 server on the tunnel), the gateway-side library (HTTP/2 client per tunnel, Postgres registry, fencing, drain, internal reverse proxy). Generated proto code lives in `libs/proto` (Go) and `packages/proto` (TS). `packages/agent-client` routes Connect calls to the owning gateway pod and resumes attach streams by offset.

**Tech Stack:** Go 1.27.3, std `net/http` HTTP/2 (h2c over the tunnel `net.Conn`), `github.com/coder/websocket` v1.8.15, `connectrpc.com/connect` v1.21.1, `google.golang.org/protobuf` v1.36.12, `github.com/jackc/pgx/v5` v5.11.0, `golang.org/x/sys` v0.49.0; buf 1.75.0; TS: `@connectrpc/connect`/`-node` 2.3.0, `@bufbuild/protobuf`/`protoc-gen-es` 2.16.0, `pg` 8.23.1, vitest, biome; Postgres 18.6 (`postgres:18.6-alpine`) for tests.

**Spec:** `docs/specs/s2-tunnel-protocol.md` (source of truth; section numbers below refer to it).

## Global Constraints

- Tools only through mise (`mise exec -- <cmd>` in non-interactive shells). Re-check latest stable before adding any dependency; the versions above were checked 2026-10-29.
- Go modules: `libs/proto` (`github.com/belov38/boat-dev-clone/libs/proto`), `libs/tunnel` (`github.com/belov38/boat-dev-clone/libs/tunnel`); `go 1.27`, `toolchain go1.27.3`; registered in `go.work`; `libs/tunnel/go.mod` has `replace github.com/belov38/boat-dev-clone/libs/proto => ../proto` so `go mod tidy` works outside the workspace.
- No cgo anywhere. `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./... && go vet ./...` must pass for both modules.
- Do not create `services/guest-agent` or `services/gateway`. Test-only code lives in `libs/tunnel/tunneltest/...` or `internal/...` and is never imported by non-test library code.
- Code comments in English. No `Claude-Session:` trailers or session links in commits.
- Root files (`go.work`, `package.json`, `pnpm-workspace.yaml`, `mise.toml`, `biome.json`): add only our own entries.
- HTTP/2: std `net/http` (spec §18 allows it; `x/net/http2` v0.62.0 is deprecated in favour of std). Server: `Protocols` = UnencryptedHTTP2 only, `HTTP2Config{MaxConcurrentStreams: 1000, MaxReceiveBufferPerStream: 1<<20, MaxReceiveBufferPerConnection: 16<<20, MaxReadFrameSize: 16<<10}`. Client (gateway): same receive buffers and frame size, `SendPingTimeout: 10s`, `PingTimeout: 5s`.
- Wire names (§4.1): path `/v1/connect`, subprotocol `sbx-tunnel.v1`, headers `Authorization` (`Bearer <MT>` / `Sbx-Bootstrap <BS>`), `Sbx-Machine-Id`, `Sbx-Boot-Id`, `Sbx-Agent-Instance-Id`, `Sbx-Vmgenid`, `Sbx-Agent-Version`; response `Sbx-Gateway-Instance`, `Sbx-Conn-Epoch`, plus `Sbx-Conn-Id` (additive, for agent logs). Secrets on the wire: base64url without padding of the 32 raw bytes; DB stores SHA-256 of the raw bytes.
- Timings (§6, §7) are defaults in config structs so tests can shrink them: WS ping 5 s / dead 15 s; h2 ping idle 10 s / timeout 5 s; TCP keepalive 15 s; `TCP_USER_TIMEOUT` 20 s (Linux); backoff first 0–250 ms, then 500 ms ×2 to 10 s full jitter, reset after 30 s stable; reject delays 401-BS 60 s, 403 5 min, 426 5 min, 503 `Retry-After` + jitter; heartbeat 5 s, stale 15 s, sweep 5 s; endpoint wait 5 s, `spreadMs` 5000, `tcpDeadline` 2 min, agent closes old conn at `tcpDeadline + 10 s`; event batch 500 / 1 s; MT max age 24 h.
- Postgres in tests: env `SBX_TEST_DATABASE_URL` if set, otherwise the helper starts `postgres:18.6-alpine` in Docker. No silent skips: missing Docker and no URL is a test failure unless `SBX_TEST_SKIP_PG=1`.

## Review Focus

1. **Upstream dies in the middle of a Connect stream envelope.** The client must get a retryable failure, never a truncated message parsed as valid. Test in Task 9: cut the tunnel while a 64 KiB attach event is in flight; the Go Connect client gets `unavailable` or a transport error, and the next attach from the last offset returns the exact bytes.
2. **The LISTEN connection to Postgres drops.** Missed NOTIFYs must not leave a stale session serving calls. Test in Task 6 (`Listen` calls `fn("")` after reconnect) and Task 7 (gateway resyncs every local session on `""`).
3. **Every dial gets `503` during a rollout.** The agent must keep honouring `Retry-After` plus jitter and not spin. Test in Task 5 with memnet rejecting all dials: attempt timestamps are spaced by at least `Retry-After`.
4. **Slow consumer on attach.** Nothing in agent or gateway buffers unboundedly. Test in Task 9: the client stops reading; bytes produced by the double's `Attach` sender minus bytes the client consumed stay under 4 MiB.
5. **Stale gateway rows.** `agent-client` must not route to an instance whose `heartbeat_at` is older than 15 s even if `tunnel_sessions.state = connected`. Test in Task 11 (`PgRegistry.lookup` returns `undefined` for a stale instance).

## Deviations from the spec (executor decisions, §18)

- Std `net/http` HTTP/2 instead of `x/net/http2` (deprecated upstream; std gives h2c on a given `net.Conn` via `Server.Serve` on a one-conn listener and `Transport.NewClientConn`). Checked by a spike on 2026-10-29: streaming flush, CONNECT with half-close, SETTINGS values.
- `MachineConn.Ping` is a `Control/Info` round trip: std `http.ClientConn` has no PING API. h2 PING liveness itself runs inside std via `SendPingTimeout`/`PingTimeout`.
- Prometheus metrics (§13) are left to the S4 and S3 binaries; the library logs every connection change with `connId`, `epoch` and reason via `slog`.
- Additive wire fields: response header `Sbx-Conn-Id`; `ErrorDetail.instance_url`; `421`/`503` from the internal listener carry `Sbx-Error-Code` and `Sbx-Instance-Url` headers so Connect clients can read them from error metadata.
- `/v1/machines/{id}/tcp/{port}` is served as HTTP/1.1 `CONNECT <path>` with hijack (HTTP/2 CONNECT has no path without extended CONNECT); `DialRemoteTCP` is the Go client for it.
- buf lint `SERVICE_SUFFIX` is disabled to keep the spec's service names (`Control`, `Events`, `Process`).

---

## File structure

```
mise.toml                               + buf
go.work                                 + ./libs/proto ./libs/tunnel
.github/workflows/tunnel.yml            CI for this scope (Go, proto, TS)
proto/buf.yaml, buf.gen.yaml, buf.gen.test.yaml
proto/sbx/tunnel/v1/{errors,event,control,events,delivery}.proto
proto/sbx/testing/v1/process.proto      test double API (not shipped)
libs/proto/                             generated Go (committed): sbx/tunnel/v1, tunnelv1connect
libs/tunnel/
  .golangci.yml
  wire/          constants, secrets encoding, smbios serial, semver compare
  transport/     Hello, ConnInfo, Dialer, Admitter, Admission, MachineConn, errors
  rpcconv/       ErrorDetail helpers, Sbx-Request-Id interceptor
  h2/            HTTP/2 server and client-conn construction with spec parameters, conn listener
  wstransport/   WebSocket dialer (agent) and handler (gateway), socket options
  agent/         agent-side tunnel client
  registry/      Postgres store, migrations, LISTEN, sweep
  gateway/       admission, sessions, fencing, drain, internal handler, proxy, events, remote TCP
  tunneltest/memnet/   in-memory transport with fault injection
  tunneltest/process/  Process double (commandId/offset/exit contract)
  tunneltest/journal/  in-memory EventJournal
  tunneltest/testpb/   generated Go for sbx.testing.v1
  internal/pgtest/     Postgres test helper
  internal/e2e/        multi-gateway scenario tests
  internal/cmd/tunnelharness/  process used by TS e2e tests
packages/proto/         @sbx/proto: generated TS for sbx.tunnel.v1
packages/agent-client/  @sbx/agent-client; test/gen = generated TS for sbx.testing.v1
```

---

### Task 1: Proto, buf and generated code

**Files:**
- Modify: `mise.toml` (add `buf = "1.75.0"` after checking latest), `go.work`
- Create: `proto/buf.yaml`, `proto/buf.gen.yaml`, `proto/buf.gen.test.yaml`, `proto/sbx/tunnel/v1/*.proto`, `proto/sbx/testing/v1/process.proto`
- Create (generated): `libs/proto/go.mod`, `libs/proto/sbx/tunnel/v1/...`, `libs/tunnel/tunneltest/testpb/...` (generated into place; `libs/tunnel/go.mod` is created in Task 2, so generate test Go code here and let Task 2 make it compile), `packages/proto/src/gen/...`, `packages/agent-client/test/gen/...`
- Create: `packages/proto/package.json`, `packages/proto/tsconfig.json`, `packages/proto/src/index.ts`

**Interfaces:**
- Produces Go package `github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1` (`tunnelv1`) and `.../tunnelv1connect`; Go `github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1` (`testingv1`) + `testingv1connect`; TS `@sbx/proto` exporting everything from `src/gen/sbx/tunnel/v1/*_pb.js`.
- Proto content (package `sbx.tunnel.v1`, `go_package` set per file):
  - `errors.proto`: `ErrorDetail { string code = 1; bool retryable = 2; string instance_url = 3; }` (`instance_url` set only for `machine_moved`; additive to §10.1).
  - `event.proto`: `Event { uint64 seq = 1; google.protobuf.Timestamp time = 2; string boot_id = 3; string type = 4; google.protobuf.Any payload = 5; }`; `ConnectionEvent { string machine_id = 1; uint64 epoch = 2; string type = 3; google.protobuf.Timestamp time = 4; string instance_id = 5; }` with `type` one of `connected|disconnected|agent_restarted|rebooted|identity_changed` (documented in a comment).
  - `control.proto`: `service Control { rpc Info(InfoRequest) returns (InfoResponse) {option idempotency_level = NO_SIDE_EFFECTS;} rpc SetToken(SetTokenRequest) returns (SetTokenResponse) {option idempotency_level = IDEMPOTENT;} rpc Drain(DrainRequest) returns (DrainResponse) {option idempotency_level = IDEMPOTENT;} }`; `InfoResponse { string agent_version = 1; string os = 2; string arch = 3; repeated string proto_packages = 4; repeated string capabilities = 5; }`; `SetTokenRequest { bytes token = 1; }`; `DrainRequest { string reason = 1; google.protobuf.Duration tcp_deadline = 2; }`; empty `InfoRequest`, `SetTokenResponse`, `DrainResponse`.
  - `events.proto`: `service Events { rpc Subscribe(SubscribeRequest) returns (stream SubscribeResponse) {option idempotency_level = NO_SIDE_EFFECTS;} rpc Ack(AckRequest) returns (AckResponse) {option idempotency_level = IDEMPOTENT;} }`; `SubscribeRequest { optional uint64 after_seq = 1; }` (absent → agent resumes after its stored acked seq); `SubscribeResponse { Event event = 1; }`; `AckRequest { uint64 seq = 1; }`.
  - `delivery.proto`: body of `POST /internal/v1/agent-events` in `api`: `AgentEventsRequest { string machine_id = 1; repeated Event events = 2; repeated ConnectionEvent connection_events = 3; }`, `AgentEventsResponse { uint64 acked_seq = 1; }`. Sent as protojson.
  - `sbx/testing/v1/process.proto` (package `sbx.testing.v1`): `service Process` with `Start(StartRequest) returns (StartResponse)`; `Attach(AttachRequest) returns (stream AttachResponse) {NO_SIDE_EFFECTS}`; `Run(RunRequest) returns (stream AttachResponse)`; `SetLabel(SetLabelRequest) returns (SetLabelResponse)` (mutating unary, exercises `Sbx-Request-Id`); `Signal(SignalRequest) returns (SignalResponse) {IDEMPOTENT}`. Messages: `CommandSpec { uint32 lines = 1; uint32 line_bytes = 2; google.protobuf.Duration interval = 3; int32 exit_code = 4; }`; `StartRequest/RunRequest { string command_id = 1; CommandSpec spec = 2; }`; `StartResponse { string command_id = 1; bool created = 2; }`; `AttachRequest { string command_id = 1; uint64 stdout_offset = 2; uint64 stderr_offset = 3; }`; `enum Stream { STREAM_UNSPECIFIED = 0; STREAM_STDOUT = 1; STREAM_STDERR = 2; STREAM_PTY = 3; }`; `enum ExitStatus { EXIT_STATUS_UNSPECIFIED = 0; EXIT_STATUS_EXITED = 1; EXIT_STATUS_KILLED = 2; EXIT_STATUS_LOST = 3; }`; `AttachResponse { oneof event { DataEvent data = 1; HeartbeatEvent heartbeat = 2; TruncatedEvent truncated = 3; ExitEvent exit = 4; StartedEvent started = 5; } }` with `DataEvent { Stream stream = 1; uint64 offset = 2; bytes data = 3; }`, `TruncatedEvent { Stream stream = 1; uint64 available_from = 2; }`, `ExitEvent { ExitStatus status = 1; int32 code = 2; string signal = 3; uint64 stdout_end = 4; uint64 stderr_end = 5; }`, `StartedEvent { string command_id = 1; }`; `SetLabelRequest { string command_id = 1; string label = 2; }`; `SignalRequest { string command_id = 1; string signal = 2; }`; `SetLabelResponse { uint64 calls = 1; }` (counts real executions, for dedup tests).
- `buf.yaml` v2, module root `proto/`, lint `STANDARD` except `SERVICE_SUFFIX` (spec names `Control`, `Events`, `Process`), breaking `FILE`.
- `buf.gen.yaml` (excludes `sbx/testing`): remote plugins `buf.build/protocolbuffers/go:v1.36.12` and `buf.build/connectrpc/go:v1.21.1` → `../libs/proto` with `module=github.com/belov38/boat-dev-clone/libs/proto`; `buf.build/bufbuild/es:v2.16.0` → `../packages/proto/src/gen` with `target=ts,import_extension=js`. `buf.gen.test.yaml`: same plugins for `sbx/testing` only → `../libs/tunnel/tunneltest/testpb` (`module=github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb`) and `../packages/agent-client/test/gen`. If remote plugins are unavailable, use local plugins pinned in mise (`go:google.golang.org/protobuf/cmd/protoc-gen-go`, `go:connectrpc.com/connect/cmd/protoc-gen-connect-go`) and `protoc-gen-es` from `packages/proto` devDependencies; record the choice in the plan.
- `@sbx/proto` package.json: `"type": "module"`, exports `".": { "source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }`, scripts `build: tsc -p tsconfig.json`, `typecheck: tsc --noEmit -p tsconfig.json`; dependency `@bufbuild/protobuf`.

- [ ] **Step 1:** Add `buf` to `mise.toml`, run `mise install`; write the protos and buf configs.
- [ ] **Step 2:** Run `cd proto && mise exec -- buf lint` → no output, exit 0.
- [ ] **Step 3:** Run `buf generate` and `buf generate --template buf.gen.test.yaml`; create `libs/proto/go.mod` (`require google.golang.org/protobuf v1.36.12`, `connectrpc.com/connect v1.21.1`), `go work use ./libs/proto`, `go mod tidy`; `cd libs/proto && go build ./... && GOOS=windows CGO_ENABLED=0 go build ./...` → exit 0.
- [ ] **Step 4:** Create `packages/proto`, `pnpm install`, `pnpm --filter @sbx/proto build` → `dist/index.js` exists; `pnpm lint` passes (generated dirs excluded in `biome.json` only if biome complains: add `!**/gen/**` to `files.includes`).
- [ ] **Step 5:** Commit `proto: add sbx.tunnel.v1 and test Process API with generated code`.

### Task 2: Go module skeleton: wire, transport, rpcconv, h2

**Files:**
- Create: `libs/tunnel/go.mod`, `libs/tunnel/.golangci.yml`, `libs/tunnel/wire/{wire.go,secret.go,semver.go}`, `libs/tunnel/transport/transport.go`, `libs/tunnel/rpcconv/{errors.go,requestid.go}`, `libs/tunnel/h2/h2.go` and tests next to each.

**Interfaces:**
- `wire`: constants from Global Constraints (`ConnectPath`, `Subprotocol`, `HeaderMachineID`, `HeaderBootID`, `HeaderAgentInstanceID`, `HeaderVmgenid`, `HeaderAgentVersion`, `HeaderLane` (reserved), `HeaderGatewayInstance`, `HeaderConnEpoch`, `HeaderConnID`, `HeaderRequestID = "Sbx-Request-Id"`, `HeaderCaller = "Sbx-Caller"`, `HeaderErrorCode = "Sbx-Error-Code"`, `HeaderInstanceURL = "Sbx-Instance-Url"`, `SchemeBearer = "Bearer"`, `SchemeBootstrap = "Sbx-Bootstrap"`, `NotifyChannel = "tunnel_sessions"`, error codes `CodeMachineMoved = "machine_moved"`, `CodeAgentUnavailable = "agent_unavailable"`, `CodeAgentOutdated = "agent_outdated"`, `CodeRequestIDRequired = "request_id_required"`, `ServicePrefixAgent = "sbx.agent.v1."`, `ServicePrefixTunnel = "sbx.tunnel.v1."`, `SecretLen = 32`).
  - `func EncodeSecret(b []byte) string`, `func DecodeSecret(s string) ([]byte, error)` (base64url raw; error unless 32 bytes), `func HashSecret(b []byte) []byte` (SHA-256), `func NewSecret() ([]byte, error)` (crypto/rand).
  - `func SMBIOSSerial(machineID string, bs []byte) string` → guest-visible `"sbx1:<machineId>:<base64url(BS)>"` (S1 base64-encodes it again for `base64=1`); `func ParseSMBIOSSerial(s string) (machineID string, bs []byte, err error)` rejects other versions.
  - `func CompareVersions(a, b string) (int, error)` for `MAJOR.MINOR.PATCH[-pre]` with optional `v` prefix (semver precedence, no build metadata ordering).
- `transport`:
  ```go
  type AuthScheme int // AuthBootstrap, AuthToken
  type Hello struct {
      MachineID, BootID, AgentInstanceID, Vmgenid, AgentVersion string
      Scheme AuthScheme
      Secret []byte
      ProtoVersion string // negotiated subprotocol, set by the transport on the gateway side
  }
  type ConnInfo struct { GatewayInstance string; Epoch uint64; ConnID string }
  type Dialer interface { Dial(ctx context.Context, hello Hello) (net.Conn, ConnInfo, error) }
  type Admitter interface { Admit(ctx context.Context, hello Hello) (Admission, error) } // error is *RejectError for HTTP-level refusals
  type Admission interface {
      Info() ConnInfo
      Serve(conn net.Conn) // takes ownership; returns immediately
      Abort(err error)     // transport failed after admission, before Serve
  }
  type RejectError struct { Status int; RetryAfter time.Duration; Reason string }
  type DrainOptions struct { Reason string; TCPDeadline time.Duration }
  type MachineConn interface { // §4.5, verbatim
      RoundTrip(req *http.Request) (*http.Response, error)
      DialTCP(ctx context.Context, port uint16) (net.Conn, error)
      Ping(ctx context.Context) error
      Drain(ctx context.Context, opts DrainOptions) error
      Close() error
  }
  type DialError struct { Status int } // CONNECT refused by agent (400/403/502)
  type MovedError struct { InstanceURL string } // remote /tcp/ answered 421
  ```
  `func (h Hello) Header() http.Header` and `func ParseHello(h http.Header) (Hello, error)` (malformed or missing `Authorization` → `*RejectError{Status: 401}`, missing machine id → 400).
- `rpcconv`:
  - `func NewError(code connect.Code, detailCode, msg string) *connect.Error` attaching `tunnelv1.ErrorDetail{Code: detailCode, Retryable: Retryable(code)}`; `func Retryable(code connect.Code) bool` (true only for `CodeUnavailable`, `CodeDeadlineExceeded`); `func Detail(err error) (*tunnelv1.ErrorDetail, bool)`.
  - `func RequireRequestID(exempt ...string) connect.Interceptor`: handler-side; for unary handlers whose `Spec.IdempotencyLevel` is neither `IdempotencyIdempotent` nor `IdempotencyNoSideEffects` and whose procedure is not in `exempt`, a missing or non-UUID/non-ULID `Sbx-Request-Id` → `invalid_argument` with detail code `request_id_required`. Streaming handlers pass through.
- `h2`:
  - `type ServerConfig struct { MaxConcurrentStreams int; StreamWindow, ConnWindow, MaxFrame int }` with `DefaultServerConfig()` = 1000 / 1 MiB / 16 MiB / 16 KiB; `func NewServer(h http.Handler, cfg ServerConfig) *http.Server` (Protocols = UnencryptedHTTP2 only).
  - `type ConnListener` (`New() *ConnListener`, `Push(net.Conn) error`, `Accept`, `Close`, `Addr`) to feed tunnel conns into one `http.Server`.
  - `type ClientConfig struct { StreamWindow, ConnWindow, MaxFrame int; PingIdle, PingTimeout time.Duration }` with `DefaultClientConfig()` = 1 MiB / 16 MiB / 16 KiB / 10 s / 5 s; `func NewClientConn(ctx context.Context, conn net.Conn, cfg ClientConfig) (*http.ClientConn, error)` (one-shot `DialContext` returning `conn`, scheme `http`).

- [ ] **Step 1: Write failing tests:** `wire`: `TestSecretRoundTrip`, `TestDecodeSecretRejectsWrongLength`, `TestSMBIOSSerialRoundTrip` (`ParseSMBIOSSerial(SMBIOSSerial(id, bs))` returns same values; `"sbx2:..."` → error), `TestCompareVersions` table (`1.2.3 < 1.10.0`, `1.0.0-rc.1 < 1.0.0`, `v1.0.0 == 1.0.0`, garbage → error). `transport`: `TestHelloHeaderRoundTrip` for both schemes, `TestParseHelloErrors` (no auth → 401, bad scheme → 401, missing machine id → 400). `rpcconv`: `TestRequireRequestID` using a real Connect handler for `sbx.testing.v1.Process` (stub implementation) over `httptest`: `SetLabel` without header → `invalid_argument` + detail `request_id_required`; with a UUID → OK; `Signal` (IDEMPOTENT) and `Start` (passed in `exempt`) without header → OK; `Attach` stream without header → OK. `TestNewErrorRetryable`. `h2`: `TestServerSettings` reads the server's first SETTINGS and the stream-0 WINDOW_UPDATE with `golang.org/x/net/http2.Framer` (test-only dependency) and asserts `MAX_CONCURRENT_STREAMS=1000`, `INITIAL_WINDOW_SIZE=1048576`, `MAX_FRAME_SIZE=16384`, connection window `16777216`; `TestClientConnOverPipe` does a streaming GET and a CONNECT with half-close over `net.Pipe`.
- [ ] **Step 2:** `cd libs/tunnel && mise exec -- go test ./...` → FAIL (undefined symbols).
- [ ] **Step 3:** Implement. `go.mod` with the `replace` for `libs/proto`; `go work use ./libs/tunnel`. `.golangci.yml`: v2 config, default linters plus `errorlint`, `gocritic`, `revive`, `bodyclose`, `contextcheck`, `noctx`; exclude `tunneltest/testpb`.
- [ ] **Step 4:** `go test -race ./...` → PASS; `mise exec -- golangci-lint run ./...` → 0 issues.
- [ ] **Step 5:** Commit `tunnel: wire constants, transport interfaces, rpc conventions, h2 setup`.

### Task 3: In-memory transport with fault injection (`tunneltest/memnet`)

**Files:** Create `libs/tunnel/tunneltest/memnet/{memnet.go,pipe.go}`, `memnet_test.go`.

**Interfaces:**
- Consumes: `transport.Dialer`, `Admitter`, `Admission`, `Hello`, `ConnInfo`, `RejectError`.
- Produces:
  ```go
  type Options struct { BufferSize int /*per direction, default 256 KiB*/; DeadAfter time.Duration /*emulated WS liveness, default 15s*/ }
  func New(opts Options) *Network
  func (n *Network) AddGateway(name string, adm transport.Admitter, ready func() bool)
  func (n *Network) RemoveGateway(name string)
  func (n *Network) Dialer() transport.Dialer   // "ingress": round-robin over ready gateways; none → *RejectError{Status: 503, RetryAfter: 1s}
  func (n *Network) SetDialFault(f func(transport.Hello) error) // nil clears
  func (n *Network) Links(machineID string) []*Link              // live links, oldest first
  type Link struct { MachineID, Gateway string; Info transport.ConnInfo }
  func (l *Link) Cut()                    // both ends fail now (reads/writes return net.ErrClosed)
  func (l *Link) Stall(d time.Duration)   // stop delivery for d; if d >= DeadAfter the agent end is closed at DeadAfter
  func (l *Link) Closed() <-chan struct{}
  func (n *Network) CutAll()
  ```
  Conn ends implement `net.Conn` with deadlines; bounded buffer gives backpressure; `Close` on one end yields `io.EOF` on the other after buffered data.

- [ ] **Step 1: Failing tests:** `TestDialRoutesToReadyGateway` (two gateways, first not ready → admitted by second; Info returned); `TestNoReadyGateway503`; `TestDialFault` (fault returns `*RejectError{Status: 401}` → Dial returns it unchanged); `TestPipeBackpressure` (writer blocks once `BufferSize` unread bytes are queued); `TestCut` (both ends error, `Closed()` fires); `TestStallShort` (data delayed by stall then delivered intact); `TestStallLongClosesAgentEnd` (DeadAfter 50 ms, stall 1 s → agent end closed after ~50 ms); `TestHTTP2OverMemnet` (h2 server + `h2.NewClientConn` work over a memnet link).
- [ ] **Step 2:** `go test ./tunneltest/memnet/...` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `go test -race ./tunneltest/memnet/...` → PASS; lint clean.
- [ ] **Step 5:** Commit `tunnel: in-memory transport with fault injection`.

### Task 4: WebSocket transport (`wstransport`)

**Files:** Create `libs/tunnel/wstransport/{dialer.go,handler.go,sockopt_linux.go,sockopt_other.go}`, `wstransport_test.go`.

**Interfaces:**
- Consumes: `transport.*`, `wire` headers.
- Produces:
  ```go
  type DialerConfig struct {
      URL string                  // wss://tunnel.<domain>/v1/connect
      RootCAs *x509.CertPool      // tunnel CA bundle only; system roots never used
      PingInterval time.Duration  // 5s
      PingTimeout time.Duration   // 15s: conn is dead if no pong within this
      KeepAlive time.Duration     // 15s
      UserTimeout time.Duration   // 20s, Linux only
  }
  func NewDialer(cfg DialerConfig) transport.Dialer
  type HandlerOptions struct { Subprotocols []string /* default [wire.Subprotocol] */ }
  func NewHandler(adm transport.Admitter, opts HandlerOptions) http.Handler
  func ListenConfig(keepAlive, userTimeout time.Duration) *net.ListenConfig // for the S4 tunnel listener
  ```
- Dialer: `websocket.Dial` with `Subprotocols: [sbx-tunnel.v1]`, hello headers, `http.Client` whose transport uses `TLSClientConfig{RootCAs, MinVersion: TLS1.3}` and a `net.Dialer{KeepAliveConfig{Enable, Idle: 15s, Interval: 15s, Count: 3}, Control: setUserTimeout}`. Non-101 → `*RejectError{Status, RetryAfter (parsed seconds), Reason (body ≤ 1 KiB)}`. Returns `websocket.NetConn(..., MessageBinary)` wrapped so a ping loop (`Ping` every `PingInterval`, ctx timeout `PingTimeout`) closes it on failure; reads `Sbx-Gateway-Instance`, `Sbx-Conn-Epoch`, `Sbx-Conn-Id` from the 101 response into `ConnInfo`.
- Handler: no offered subprotocol in `opts.Subprotocols` → `426`; `transport.ParseHello` error → its status; `Admit` `*RejectError` → status, `Retry-After` (whole seconds, rounded up) and reason text; other errors → 500. Success: set the three response headers, `websocket.Accept`, `NetConn` bound to a background context, `Admission.Serve(conn)`; `Accept` failure → `Admission.Abort(err)`. `Hello.ProtoVersion` = negotiated subprotocol.
- `sockopt_linux.go` sets `TCP_USER_TIMEOUT` via `golang.org/x/sys/unix`; `sockopt_other.go` (`//go:build !linux`) is a no-op.

- [ ] **Step 1: Failing tests** with `httptest.NewTLSServer` (its cert pool as `RootCAs`) and a fake admitter that records the Hello and serves an h2 client over the conn: `TestDialSuccessCarriesHelloAndInfo` (Bearer and bootstrap variants; ConnInfo epoch/instance/connId parsed; an h2 request from the fake gateway reaches an h2 server on the agent side); `TestRejectMapping` table 401/403/426/503(`Retry-After: 7` → 7 s) → `*RejectError`; `TestWrongSubprotocol426`; `TestUntrustedCARejected` (a different CA pool → TLS error, not RejectError); `TestPingTimeoutClosesConn` (handler side stops reading frames, e.g. `OnPingReceived` returns false: agent conn closes within `PingTimeout + margin`, test uses 50 ms / 200 ms); `TestAcceptFailureAborts`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `go test -race ./wstransport/...` PASS, lint clean, `GOOS=windows CGO_ENABLED=0 go build ./...` OK.
- [ ] **Step 5:** Commit `tunnel: WebSocket transport with CA pinning and ping liveness`.

### Task 5: Agent-side tunnel client (`agent`)

**Files:** Create `libs/tunnel/agent/{client.go,backoff.go,control.go,events.go,connect.go,policy.go}`, `libs/tunnel/tunneltest/journal/journal.go`, tests `agent/*_test.go`.

**Interfaces:**
- Consumes: `transport.Dialer`, `h2.NewServer`, `h2.ConnListener`, `tunnelv1`, `tunnelv1connect`, `wire`.
- Produces:
  ```go
  type Identity struct { BootID, InstanceID, Vmgenid, Version string }
  type Credentials interface {
      // Bootstrap reads machineId and BS (smbios). Called at start and again after a 401 on BS.
      Bootstrap(ctx context.Context) (machineID string, bs []byte, err error)
  }
  type EventJournal interface {
      AckedSeq() uint64
      Read(ctx context.Context, after uint64, max int) ([]*tunnelv1.Event, error) // blocks until ≥1 event with seq > after
      Ack(ctx context.Context, seq uint64) error
  }
  type DialPolicy func(host string, port int) error // returns *PolicyError
  type PolicyError struct { Status int; Reason string } // 400 bad port, 403 not local
  func LocalOnly() DialPolicy // "localhost", loopback IPs, IPs of local interfaces; other hostnames → 403 without DNS
  type Backoff struct { First, Base, Max, ResetAfter time.Duration } // 250ms, 500ms, 10s, 30s
  type RejectDelays struct { BadBootstrap, Retired, Outdated time.Duration } // 60s, 5m, 5m
  type ConnEvent struct { Kind string /*connected|disconnected|rejected|drain*/; ConnID string; Epoch uint64; Gateway string; Auth transport.AuthScheme; Status int; Reason string }
  type Config struct {
      Dialer transport.Dialer
      Credentials Credentials
      Identity Identity
      Handler http.Handler          // sbx.agent.v1 + /files (S3); nil → 404
      Info func(ctx context.Context) *tunnelv1.InfoResponse // nil → defaults
      Journal EventJournal          // nil → empty journal
      DialPolicy DialPolicy         // nil → LocalOnly()
      Backoff Backoff; RejectDelays RejectDelays
      DrainJitter time.Duration     // 250ms
      DrainCloseExtra time.Duration // 10s
      HTTP2 h2.ServerConfig
      Logger *slog.Logger
      OnConnEvent func(ConnEvent)   // optional hook, called synchronously
  }
  func New(cfg Config) (*Client, error) // fills defaults
  func (c *Client) Run(ctx context.Context) error // until ctx done; closes all conns on exit
  ```
  `journal.Mem` (`tunneltest/journal`): `New() *Mem`, `Append(type string, payload proto.Message) uint64`, plus `EventJournal` methods.
- Behaviour to implement:
  - One `http.Server` per Client fed by `h2.ConnListener`; `ConnContext` stores the per-conn state so handlers know their conn; `ConnState(StateClosed)` signals conn end.
  - Mux: `CONNECT` → TCP handler; `/sbx.tunnel.v1.Control/` and `/sbx.tunnel.v1.Events/` → library handlers; everything else → `cfg.Handler`.
  - Auth: MT in memory (set by `SetToken`); hello uses Bearer MT if present else bootstrap BS. Reject handling per §5.3: 401+MT → drop MT, retry now with BS; 401+BS → `Credentials.Bootstrap` again, wait `BadBootstrap`; 403 → `Retired`; 426 → `Outdated`; 503 → `RetryAfter + rand[0, RetryAfter/5]`, then normal backoff; other errors → backoff.
  - `Info` default: `{agent_version: Identity.Version, os: runtime.GOOS, arch: runtime.GOARCH, proto_packages: ["sbx.tunnel.v1"]}`; a provided `Info` result gets `sbx.tunnel.v1` appended to `proto_packages` if missing.
  - `Drain`: replies immediately; if received on the current conn and no replacement is in progress, after `rand[0, DrainJitter]` dials a replacement while the old conn keeps serving (rejections retried with backoff); when the replacement is up, the old conn is closed after `tcp_deadline + DrainCloseExtra` (spec default `tcp_deadline` 2 min if zero).
  - `Subscribe`: `after = req.after_seq` if set else `Journal.AckedSeq()`; loop `Read` → `Send` one `SubscribeResponse` per event; `Ack` → `Journal.Ack`.
  - CONNECT: parse `r.Host` (`host:port`), policy, dial with 10 s timeout (failure → 502), `200` + flush, copy both ways; request body EOF → `CloseWrite` on the target; target EOF → return.
  - Every conn change is logged with `connId`, `epoch`, reason (§13) and passed to `OnConnEvent`.
- Test harness inside the test package: a fake admitter on memnet that runs `h2.NewClientConn` on the gateway end and exposes it, with scripted reject statuses.

- [ ] **Step 1: Failing tests:**
  - `TestConnectsWithBootstrapThenToken`: first hello is bootstrap; fake gateway calls `SetToken`; cut the link; second hello is Bearer with that token.
  - `TestUnauthorizedTokenFallsBackToBootstrap`: fake answers 401 to Bearer → next dial within 50 ms uses bootstrap.
  - `TestBadBootstrapRereadsCredentials`: 401 to bootstrap → `Bootstrap` called again, next attempt ≥ `BadBootstrap` (test sets 100 ms).
  - `TestRejectDelays` table: 403 → ≥ `Retired`; 426 → ≥ `Outdated`; 503 `RetryAfter` 100 ms → every gap ≥ 100 ms across 5 consecutive 503s (Review Focus 3).
  - `TestBackoffSchedule`: unit test on `Backoff` with seeded rand: first ≤ 250 ms, caps grow 500 ms, 1 s, 2 s … ≤ 10 s; `Reset` after stable.
  - `TestInfoDefaults` and `TestInfoProvided`.
  - `TestDrainMakeBeforeBreak`: Drain on conn A with `tcp_deadline` 100 ms and `DrainCloseExtra` 50 ms → conn B dialed while an in-flight CONNECT stream on A keeps working; A closed ~150 ms after B is up.
  - `TestConnectPolicy`: CONNECT to a local listener → bytes echo, half-close both directions works; `10.255.255.1:80` → 403; `example.com:80` → 403; port `0` and `70000` → 400; refused local port → 502.
  - `TestEventsSubscribeAndAck`: journal with seq 1..3, acked 1 → Subscribe without `after_seq` yields 2, 3; `Ack(3)` → `AckedSeq()==3`; appending seq 4 is delivered on the open stream.
  - `TestRunExitsOnCancel`: cancel → `Run` returns, conns closed.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `go test -race ./agent/... ./tunneltest/journal/...` PASS, lint clean.
- [ ] **Step 5:** Commit `tunnel: agent-side tunnel client`.

### Task 6: Registry (`registry`) and Postgres test helper

**Files:** Create `libs/tunnel/registry/{store.go,listen.go,migrate.go}`, `libs/tunnel/registry/migrations/0001_init.sql`, `libs/tunnel/internal/pgtest/pgtest.go`, `registry/store_test.go`.

**Interfaces:**
- `pgtest`: `func Main(m *testing.M)` (starts/stops the container once per package when needed) and `func New(t testing.TB) (*pgxpool.Pool, string /*dsn*/)` (fresh database per test, migrated with `registry.Migrate`). Container: `docker run -d --rm -e POSTGRES_PASSWORD=sbx -p 127.0.0.1::5432 postgres:18.6-alpine`, port via `docker port`, ready when `SELECT 1` succeeds.
- `0001_init.sql`: `CREATE SCHEMA tunnel`; tables per §8.1 with types: `gateway_instances(id text primary key, internal_url text not null, state text not null check (state in ('active','draining')), started_at timestamptz not null, heartbeat_at timestamptz not null)`; `tunnel_sessions(machine_id uuid primary key, instance_id text not null, epoch bigint not null, conn_id text not null, agent_instance_id text not null, boot_id text not null, vmgenid text not null, agent_version text not null, proto_version text not null, capabilities text[] not null default '{}', state text not null check (state in ('connected','disconnected')), connected_at timestamptz not null, disconnected_at timestamptz)` + index on `instance_id`; `tunnel_credentials(machine_id uuid primary key, bs_hash bytea not null, mt_hash bytea, mt_next_hash bytea, mt_issued_at timestamptz, retired_at timestamptz)`. Triggers: after insert or update on `tunnel_sessions` and after update of `retired_at` on `tunnel_credentials` → `pg_notify('tunnel_sessions', machine_id::text)`. `tunnel.schema_migrations(version int primary key, applied_at timestamptz)`.
- `registry`:
  ```go
  func Migrate(ctx context.Context, pool *pgxpool.Pool) error // embedded migrations, pg_advisory_xact_lock, idempotent
  func New(pool *pgxpool.Pool) *Store
  var ErrUnauthorized, ErrRetired, ErrNotFound error
  type Session struct { MachineID, InstanceID, ConnID, AgentInstanceID, BootID, Vmgenid, AgentVersion, ProtoVersion string; Epoch uint64; Capabilities []string; State string; ConnectedAt time.Time; DisconnectedAt *time.Time }
  type AdmitParams struct { MachineID, InstanceID, ConnID, AgentInstanceID, BootID, Vmgenid, AgentVersion, ProtoVersion string; Scheme transport.AuthScheme; SecretHash []byte }
  type AdmitResult struct { Epoch uint64; Prev *Session; MTIssuedAt *time.Time }
  func (s *Store) Admit(ctx context.Context, p AdmitParams) (AdmitResult, error)
  func (s *Store) UpdateSessionInfo(ctx context.Context, machineID string, epoch uint64, capabilities []string) (bool, error)
  func (s *Store) Disconnect(ctx context.Context, machineID, instanceID string, epoch uint64) (bool, error)
  func (s *Store) Session(ctx context.Context, machineID string) (Session, error)
  type Owner struct { InstanceID, InternalURL string; Epoch uint64 }
  func (s *Store) Owner(ctx context.Context, machineID string, staleAfter time.Duration) (Owner, bool, error)
  func (s *Store) Retired(ctx context.Context, machineID string) (bool, error)
  func (s *Store) BeginRotation(ctx context.Context, machineID string, nextHash []byte) error
  func (s *Store) CompleteRotation(ctx context.Context, machineID string, nextHash []byte) (bool, error)
  func (s *Store) RegisterInstance(ctx context.Context, id, internalURL string) error
  func (s *Store) Heartbeat(ctx context.Context, id string) error
  func (s *Store) SetInstanceState(ctx context.Context, id, state string) error
  func (s *Store) DeleteInstance(ctx context.Context, id string) error
  type Swept struct { MachineID, InstanceID string; Epoch uint64; DisconnectedAt time.Time }
  func (s *Store) SweepStale(ctx context.Context, self string, staleAfter time.Duration) ([]Swept, error)
  func (s *Store) Listen(ctx context.Context, fn func(machineID string)) error // blocks; on (re)connect calls fn("") = resync all
  // Writers owned by worker (S6); exported for tests and as SQL reference.
  func (s *Store) PutCredentials(ctx context.Context, machineID string, bsHash []byte) error
  func (s *Store) Retire(ctx context.Context, machineID string) error
  ```
- `Admit` in one transaction: `SELECT ... FROM tunnel_credentials WHERE machine_id=$1 FOR UPDATE` (missing → `ErrUnauthorized`); `retired_at` set → `ErrRetired` (checked before the secret); bootstrap: constant-time compare with `bs_hash`; token: match `mt_hash`, or `mt_next_hash` which promotes it (`mt_hash = mt_next_hash, mt_next_hash = null, mt_issued_at = now()`); read previous session; upsert session with `epoch = coalesce(prev.epoch, 0) + 1`, `state='connected'`, `connected_at=now()`, `disconnected_at=null`; NOTIFY comes from the trigger at commit. `MTIssuedAt` is returned for the gateway's rotation decision.
- `Disconnect` updates only `WHERE machine_id=$1 AND instance_id=$2 AND epoch=$3 AND state='connected'` (fencing).
- `SweepStale`: in one transaction `SELECT id, heartbeat_at FROM gateway_instances WHERE id <> self AND heartbeat_at < now() - staleAfter FOR UPDATE SKIP LOCKED`; per instance set its connected sessions to `disconnected` with `disconnected_at = heartbeat_at` (returning rows), delete the instance.
- `Owner`: `tunnel_sessions` join `gateway_instances` where `state='connected'` and `heartbeat_at > now() - staleAfter`.

- [ ] **Step 1: Failing tests** (all with `pgtest.New`):
  - `TestMigrateIdempotent` (twice, concurrently from two goroutines).
  - `TestAdmitBootstrap` (right BS → epoch 1, `Prev == nil`; wrong → `ErrUnauthorized`; unknown machine → `ErrUnauthorized`).
  - `TestAdmitIncrementsEpochAndReturnsPrev` (second admit → epoch 2 with `Prev.AgentInstanceID` of the first).
  - `TestAdmitRetired` (`Retire` then admit with right BS → `ErrRetired`).
  - `TestTokenRotation` (`BeginRotation(h1)`; admit with token h1 → OK and promoted; old `mt_hash` h0 still valid before promotion; after promotion h0 → `ErrUnauthorized`; `CompleteRotation(h1)` after promotion → false, no error).
  - `TestDisconnectFencing` (disconnect with stale epoch → false; with current → true, `State == "disconnected"`).
  - `TestOwnerIgnoresStaleInstance` (heartbeat set 20 s in the past via SQL → not found).
  - `TestSweepStale` (instance B stale with 2 connected sessions → both disconnected with `disconnected_at` = B's heartbeat, B deleted, `self` never swept; two concurrent sweepers return disjoint results).
  - `TestListenNotifies` (Admit, `UpdateSessionInfo`, `Retire` each produce `fn(machineID)`; `pg_terminate_backend` of the listener backend → `fn("")` after reconnect, then notifications resume) — Review Focus 2.
- [ ] **Step 2:** FAIL. **Step 3:** implement (pgx v5 `pgxpool`; `Listen` uses `pool.Acquire` + `LISTEN` + `WaitForNotification`, reconnect with 250 ms→5 s backoff).
- [ ] **Step 4:** `go test -race ./registry/...` PASS; lint clean.
- [ ] **Step 5:** Commit `tunnel: Postgres registry with fencing, sweep and LISTEN`.

### Task 7: Gateway core: admission, sessions, fencing, events (`gateway`)

**Files:** Create `libs/tunnel/gateway/{gateway.go,admit.go,session.go,machineconn.go,events.go,fence.go}`, tests `gateway/*_test.go`.

**Interfaces:**
- Consumes: `registry.Store`, `transport.*`, `h2.NewClientConn`, `tunnelv1connect` clients, `wire`, `rpcconv`.
- Produces:
  ```go
  type Timing struct {
      Heartbeat, StaleAfter, Sweep time.Duration           // 5s, 15s, 5s
      EndpointWait, DrainSpread, TCPDeadline time.Duration  // 5s, 5s, 2m
      DrainRetryAfter time.Duration                         // 1s, Retry-After for 503 while draining
      TokenMaxAge time.Duration                             // 24h
      EventBatchMax int; EventBatchInterval time.Duration   // 500, 1s
  }
  type EventSink interface {
      DeliverEvents(ctx context.Context, machineID string, events []*tunnelv1.Event) (ackedSeq uint64, err error)
      DeliverConnectionEvent(ctx context.Context, ev *tunnelv1.ConnectionEvent) error
  }
  func NewHTTPSink(apiURL, serviceToken string, client *http.Client) EventSink // POST {apiURL}/internal/v1/agent-events, protojson
  type TokenSet map[string][]string // caller → up to two valid service tokens
  type Config struct {
      InstanceID, InternalURL string
      Store *registry.Store
      ServiceTokens TokenSet
      Sink EventSink                 // nil → log and drop, ack immediately
      MinAgentVersion string         // "" → none; lower → 426
      AllowedServicePrefixes []string // default [wire.ServicePrefixAgent]; sbx.tunnel.v1. is always refused
      Timing Timing
      HTTP2 h2.ClientConfig
      Logger *slog.Logger
  }
  func New(cfg Config) (*Gateway, error)
  func (g *Gateway) Run(ctx context.Context) error // register instance, heartbeat, sweep, LISTEN; on ctx done: close sessions (Disconnect), delete instance
  func (g *Gateway) Admitter() transport.Admitter
  func (g *Gateway) Machine(machineID string) (transport.MachineConn, bool) // active (not moved/closed) session only
  func (g *Gateway) Ready() bool
  func (g *Gateway) Abandon() // crash simulation for tests: stop loops, drop conns, touch nothing in the registry
  ```
- Admission (`Admit`): draining → `RejectError{503, DrainRetryAfter}`; `MinAgentVersion` and agent version lower or unparsable → 426; `registry.Admit` (`ErrUnauthorized` → 401, `ErrRetired` → 403); conn id = new UUIDv7 (`github.com/google/uuid`, check latest). `Abort` → `Disconnect`. `Serve` → `h2.NewClientConn` with `cfg.HTTP2` (h2 ping 10 s / 5 s lives there), register locally (an older local session for the same machine is closed), then in a goroutine: `Control/Info` → `UpdateSessionInfo(capabilities)`; rotate MT when auth was bootstrap, or `MTIssuedAt` is nil or older than `TokenMaxAge`, and every `TokenMaxAge` while connected; start the events pump; send connection events.
- Token rotation (`session.rotateToken(ctx)`, used by Task 8's `rotate-token` too): `wire.NewSecret` → `BeginRotation(hash)` → `Control/SetToken` → `CompleteRotation(hash)`.
- Connection events (`DeliverConnectionEvent`, key `(machineId, epoch, type)`): `connected` always; with `Prev`: `rebooted` if `BootID` changed, else `agent_restarted` if `AgentInstanceID` changed; `identity_changed` if `Vmgenid` changed. `disconnected` on local close (only when `Disconnect` returned true) and for every `Swept` row.
- Events pump: `Events/Subscribe` (no `after_seq`), batch up to `EventBatchMax` or `EventBatchInterval`, `DeliverEvents`; on error retry the same batch with backoff 1 s→30 s without reading further; then `Events/Ack(ackedSeq)`.
- Session states: `active` → `draining` (Drain sent) → `moved` (fenced while draining: Connect streams aborted, new calls refused with 421, TCP streams kept until `TCPDeadline`, then close) → `closed`. Fenced while not draining → `closed` immediately.
- Fencing (`fence.go`): on `fn(machineID)` load `Session` and `Retired`; local epoch < registry epoch, or retired → fence as above; `fn("")` → re-check every local session.
- `MachineConn` (`machineconn.go`): `RoundTrip` sets `URL.Scheme="http"`, `URL.Host="agent"` and tracks the request kind (`rpc-stream` by `Content-Type: application/connect+*` or `application/grpc*`, `tcp` for CONNECT, else `unary`); `DialTCP` sends `CONNECT localhost:<port>` with an `io.Pipe` body and returns a `net.Conn` with `CloseWrite`; non-200 → `*transport.DialError`; `Ping` = `Control/Info` round trip; `Drain` = `Control/Drain`; `Close` closes the h2 conn.
- Test harness: memnet + real `agent.Client` + `pgtest` + a recording `EventSink`.

- [ ] **Step 1: Failing tests:**
  - `TestFirstConnectBootstrapThenRotation`: agent connects with BS → session row `connected`, epoch 1, capabilities from Info stored; `mt_hash` set and `mt_next_hash` null; sink got `connected`; after a memnet cut the agent reconnects with Bearer (observed via `OnConnEvent.Auth`) and epoch is 2.
  - `TestRejects`: unknown machine → agent sees 401; retired → 403; `MinAgentVersion "2.0.0"` with agent `1.5.0` → 426; draining → 503 with `RetryAfter == DrainRetryAfter`.
  - `TestReconnectToOtherGatewayFencesOld`: gateways A and B on one memnet and DB; agent on A; make A not ready and cut the link → agent lands on B; A's `Machine(id)` becomes false within 1 s (NOTIFY fencing); registry owner is B; A's sink got no `disconnected` (fenced Disconnect returns false).
  - `TestRetireClosesConnection`: `Retire` → A closes the conn within 1 s; the next dial gets 403.
  - `TestConnectionEvents`: new agent instance id → `agent_restarted`; new boot id → `rebooted` (and not `agent_restarted`); new vmgenid → `identity_changed`.
  - `TestEventsPumpBatchesAndAcks`: journal 1200 events → sink batches ≤ 500; agent journal `AckedSeq()==1200`; with a sink failing twice, delivery resumes with the same first seq and no gap.
  - `TestSweepMarksCrashedInstance`: A `Abandon()`; with `StaleAfter` 300 ms, B's sweep marks A's sessions disconnected (if the agent has not yet reconnected) and A's row is gone; sink on B got `disconnected`.
  - `TestResyncOnListenReconnect`: kill the LISTEN backend while a fence-worthy change happens (admit on B via a second agent `Client` with the same machine id) → A still closes its session (Review Focus 2).
  - `TestMachineConnDialTCPAndPing`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `go test -race ./gateway/...` PASS; lint clean.
- [ ] **Step 5:** Commit `tunnel: gateway admission, sessions, fencing and event delivery`.

### Task 8: Gateway internal listener: auth, RPC/files proxy, TCP, rotate-token

**Files:** Create `libs/tunnel/gateway/{internal.go,proxy.go,envelope.go,tcp.go,auth.go}`, tests.

**Interfaces:**
- Produces:
  ```go
  func (g *Gateway) InternalHandler() http.Handler // serve with h2c + HTTP/1.1 (S4 sets Protocols)
  func DialRemoteTCP(ctx context.Context, instanceURL, serviceToken, machineID string, port uint16) (net.Conn, error) // HTTP/1.1 CONNECT; 421 → *transport.MovedError
  ```
- Routes (all require `Authorization: Bearer <service token>` from `TokenSet`, constant-time compare; else 401; `{id}` must be a UUID, else 400):
  - `* /v1/machines/{id}/rpc/{service}/{method}`: `{service}` starting with `sbx.tunnel.v1.` → 403; not matching `AllowedServicePrefixes` → 403. Upstream path `/{service}/{method}` + query.
  - `* /v1/machines/{id}/files` and `/v1/machines/{id}/files/{rest...}` → upstream `/files[/rest]` + query.
  - `CONNECT /v1/machines/{id}/tcp/{port}` over HTTP/1.1 (dispatched before the mux): hijack, `HTTP/1.1 200 Connection Established`, splice with `MachineConn.DialTCP`, half-close both ways. Port outside 1–65535 → 400.
  - `POST /v1/machines/{id}/rotate-token` → `session.rotateToken`, `200 {}`.
- Routing decision per request: active local session → proxy; local `moved` session or no local session and `Store.Owner` finds a fresh instance other than self → `421` with headers `Sbx-Error-Code: machine_moved`, `Sbx-Instance-Url: <owner internal_url>`; nothing connected → `503`, `Sbx-Error-Code: agent_unavailable`, `Retry-After: 1`. For `/rpc/` these responses carry a Connect JSON error body `{"code":"unavailable","message":"<code>","details":[ErrorDetail]}` (detail `retryable: true`, `instance_url` for moved), `Content-Type: application/json`.
- Proxy: copy headers minus hop-by-hop and `Authorization`; set `Sbx-Caller: <caller>`; keep `Connect-Timeout-Ms`, `Sbx-Request-Id`, `Content-Type`, `Connect-*`, `Accept-Encoding`; request body streamed as is; response status, headers and trailers copied; body copied with a flush after every read, no buffering.
- `envelope.go`: for `application/connect+*` responses the copier tracks 5-byte envelope boundaries. When the session is moved, or upstream fails: at a boundary, write one end-stream envelope (flags `0x02`, JSON `{"error":{"code":"unavailable","message":"machine_moved"|"agent_unavailable","details":[...]}}`) and finish; inside an envelope, `panic(http.ErrAbortHandler)` (stream reset, which `agent-client` treats as a connection error).

- [ ] **Step 1: Failing tests** (Go Connect client of `sbx.testing.v1.Process` against `httptest` h2c server running `InternalHandler`; agent `Handler` is a stub Process implementation, gateways allow prefix `sbx.testing.v1.`):
  - `TestServiceTokenRequired`: no token → 401; wrong → 401; second token of the same caller → OK; agent sees `Sbx-Caller: api` and no `Authorization`.
  - `TestTunnelServiceForbidden`: `/rpc/sbx.tunnel.v1.Control/Info` → 403; `/rpc/sbx.other.v1.X/Y` → 403.
  - `TestUnaryAndStreamProxy`: unary round trip; server stream of 100 messages arrives in order; `Sbx-Request-Id` and `Connect-Timeout-Ms` reach the agent handler.
  - `TestMachineMoved421`: session on B, call A → 421, `Sbx-Instance-Url` = B's URL, Connect error code `unavailable` with `ErrorDetail{code: machine_moved, retryable: true, instance_url}`.
  - `TestAgentUnavailable503`.
  - `TestStreamAbortedWithUnavailableOnMove`: open an attach-like stream, fence while draining → client stream ends with Connect `unavailable` (not internal) and the last message received is complete.
  - `TestFilesProxy`: `GET /files?path=x` with `Range` → 206 passes through; `PUT /files/uploads/u1?offset=0` body streamed (4 MiB) intact.
  - `TestRemoteTCP`: `DialRemoteTCP` to A for a machine on A echoes bytes with half-close; to A for a machine on B → `*transport.MovedError{InstanceURL: B}`.
  - `TestRotateToken`: `POST rotate-token` → 200; agent's next reconnect uses the new token (old `mt_hash` no longer accepted).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `go test -race ./gateway/...` PASS; lint clean.
- [ ] **Step 5:** Commit `tunnel: gateway internal listener and reverse proxy`.

### Task 9: Gateway drain, Process double and Go scenario tests

**Files:** Create `libs/tunnel/gateway/drain.go`, `libs/tunnel/tunneltest/process/{process.go,store.go}`, `libs/tunnel/internal/e2e/{harness_test.go,scenarios_test.go}`.

**Interfaces:**
- `func (g *Gateway) Drain(ctx context.Context) error` (§7 steps 1–7): set draining (local flag → `Ready()==false`, admission 503, `SetInstanceState(draining)`); wait `EndpointWait`; call `MachineConn.Drain{reason: "gateway_shutdown", tcp_deadline: TCPDeadline}` on every active session, the i-th of n at `i*DrainSpread/n`; wait until no sessions remain or `EndpointWait + DrainSpread + TCPDeadline + 10s` passes; close the rest (`Disconnect`), `DeleteInstance`, stop loops.
- `process` (test double of `Process`, honours the §9.1 contract):
  ```go
  type Store struct{...} // outlives agent Clients: plays the shim + on-disk state
  func NewStore(opts Options) *Store // Options{HeartbeatAfter time.Duration /*15s*/; RetainBytes uint64 /*0 = keep all*/}
  func (s *Store) Handler(opts ...connect.HandlerOption) (string, http.Handler) // testingv1connect handler with rpcconv.RequireRequestID(StartProcedure)
  func (s *Store) Starts(commandID string) int // times the command really started (the "marker")
  func Expected(spec *testingv1.CommandSpec) (stdout, stderr []byte) // deterministic output
  ```
  `Start` idempotent by `command_id` (same spec → `created=false`; different → `already_exists`); output generated in a goroutine into per-stream buffers, line `n` = `"<stream> <n> <padding>\n"` padded to `line_bytes`, lines alternate stdout/stderr, one line per `interval`; `Attach` sends `data` chunks ≤ 64 KiB from the requested offsets, blocks for new data, `heartbeat` after `HeartbeatAfter` of silence, `truncated` when offset < retained start, `exit` only after both streams are sent up to their ends; `Run` = `Start` + `started` event + `Attach` from 0; `SetLabel` counts executions; `Signal` kills (status `killed`).
- Go-side resume helper inside `e2e` tests only (`attachAll(ctx, client, commandID) (stdout, stderr []byte, exit *ExitEvent)`): resumes from last offsets on any retryable error, applies accept/trim/gap rules.

- [ ] **Step 1: Failing tests** (`internal/e2e`, 2–3 gateways on one memnet and DB, shrunk timings):
  - `TestLongCommandSurvivesFaults`: command 4000 lines × 1 KiB at 1 ms, exit 42; an injector every 50–300 ms does one of: `Link.Cut`, `Link.Stall(2*DeadAfter)`, `Abandon` of the owning gateway plus a fresh replacement gateway, `Drain` of the owning gateway plus replacement, replacing the agent `Client` (new `InstanceID`, same `process.Store`). Two readers via `attachAll` through the internal listeners (following 421 to `Sbx-Instance-Url`, re-looking-up the owner on 503) → both get bytes equal to `Expected`, exit 42, `Starts==1`, no single pause longer than 5 s (scaled budget).
  - `TestDrainMovesAllAgents`: 3 gateways, 20 agents each running a command with an open attach; `Drain` gateway A → every agent reconnects to B or C; `Drain` returns before its deadline; 0 lost and 0 double starts; all attach readers complete with exact bytes; a unary `SetLabel` with one `Sbx-Request-Id` sent to A after a move gets 421 and succeeds on the first retry to the given URL with `calls == 1`.
  - `TestDrainKeepsTCPUntilDeadline`: a TCP stream via `DialRemoteTCP` on A survives the move and is closed at `TCPDeadline` (300 ms) ± margin; RPC streams on A end with `unavailable` right after the move.
  - `TestAgentRestartKeepsCommands`: replace the agent `Client` mid-command → reconnect via BS (MT was in memory), `agent_restarted` event, attach completes exactly.
  - `TestCutMidEnvelope` (Review Focus 1): 64 KiB lines, cut during a message → reader gets a retryable error, resumed output exact.
  - `TestSlowConsumerBounded` (Review Focus 4): reader stops reading for 1 s while the command produces 64 MiB → `producedSent - consumed < 4 MiB` (double counts bytes handed to `Send`).
- [ ] **Step 2:** FAIL. **Step 3:** implement `Drain`, the double and the scenarios; fix library bugs they reveal (each fix with its own focused test in the owning package).
- [ ] **Step 4:** `go test -race -count=3 ./...` in `libs/tunnel` PASS (no flakes); lint clean.
- [ ] **Step 5:** Commit `tunnel: gateway drain, Process test double, scenario tests`.

### Task 10: CI workflow and Windows cross-compile

**Files:** Create `.github/workflows/tunnel.yml`.

- Jobs (ubuntu-latest, `jdx/mise-action` latest major; check latest action versions on GitHub releases):
  - `go`: Postgres `postgres:18.6-alpine` service, `SBX_TEST_DATABASE_URL`; for `libs/proto` and `libs/tunnel`: `go test -race ./...`, `golangci-lint run ./...`, `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./... && go vet ./...`, `GOOS=windows GOARCH=arm64 CGO_ENABLED=0 go build ./...`.
  - `proto`: `buf lint`; `buf generate` + `buf generate --template buf.gen.test.yaml` then `git diff --exit-code`; `buf breaking --against '.git#branch=main,subdir=proto'` only when `git cat-file -e origin/main:proto/buf.yaml`.
  - `ts`: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm -r typecheck`, `pnpm --filter @sbx/agent-client test` with Postgres service and Go available (for Task 12's harness).
- [ ] **Step 1:** Write the workflow; validate locally: run each job's commands by hand (`GOOS=windows ...` builds pass, `buf generate` leaves `git status` clean).
- [ ] **Step 2:** Commit `ci: tunnel workflow with Windows cross-compile`.

### Task 11: TS `@sbx/agent-client`

**Files:** Create `packages/agent-client/{package.json,tsconfig.json,vitest.config.ts}`, `src/{index.ts,constants.ts,registry.ts,pg-registry.ts,transport.ts,errors.ts,attach.ts}`, `test/{pg-registry.test.ts,transport.test.ts,attach.test.ts,helpers/pg.ts,helpers/fake-gateway.ts}`.

**Interfaces:**
- `package.json`: name `@sbx/agent-client`, deps `@sbx/proto` (`workspace:*`), `@connectrpc/connect`, `@connectrpc/connect-node`, `@bufbuild/protobuf`, `pg`; dev `@types/pg`. Same exports pattern as `@sbx/proto`; vitest resolves the `source` condition (`resolve.conditions` and `ssr.resolve.conditions`), tsconfig `customConditions: ["source"]`. Scripts `build`, `typecheck`, `test` (`vitest run`).
- `constants.ts`: header and code names identical to Go `wire`.
- `registry.ts`:
  ```ts
  export interface Route { machineId: string; instanceId: string; internalUrl: string; epoch: bigint; capabilities: string[] }
  export interface Registry {
    lookup(machineId: string): Promise<Route | undefined>;
    invalidate(machineId: string): void;
    waitForChange(machineId: string, timeoutMs: number, signal?: AbortSignal): Promise<void>; // NOTIFY or timeout
    close(): Promise<void>;
  }
  ```
- `pg-registry.ts`: `PgRegistry.connect({ connectionString, staleAfterMs = 15000, cacheTtlMs = 5000 }): Promise<PgRegistry>`; query = §8.4 join (state `connected`, `heartbeat_at > now() - staleAfter`); cache invalidated by `LISTEN tunnel_sessions` (dedicated `pg.Client`, reconnects and then clears the whole cache).
- `errors.ts`: `AgentUnavailableError extends ConnectError` (code `Unavailable`, `retryable = true`, detail code `agent_unavailable`), `AgentOutdatedError extends ConnectError` (code `FailedPrecondition`, detail `agent_outdated`, `capability`), `isConnectionError(err)` (ConnectError whose `cause` is a Node network/HTTP2 error: `code` matches `/^(E[A-Z]+|ERR_HTTP2_.*)$/`), `classify(err): "moved" | "unavailable" | "retry" | "fatal"`.
- `transport.ts`:
  ```ts
  export interface AgentClientOptions {
    registry: Registry; serviceToken: string;
    waitForAgentMs?: number; // 30000
    pollIntervalMs?: number; // 1000
    maxAttempts?: number;    // 10
    createTransport?: (baseUrl: string, headers: Record<string,string>) => Transport; // default connect-node, httpVersion "2"
  }
  export class AgentClient {
    constructor(opts: AgentClientOptions);
    transport(machineId: string): Transport;  // Connect Transport with routing and retries
    requireCapability(machineId: string, capability: string): Promise<void>; // AgentOutdatedError
  }
  ```
  `baseUrl = <internal_url>/v1/machines/<machineId>/rpc`, header `Authorization: Bearer <serviceToken>`. Retry loop for `unary` and for `stream` until response headers arrive: `moved` (header `sbx-error-code: machine_moved`) → invalidate, next attempt goes to `sbx-instance-url`; `unavailable` (`agent_unavailable`, `Code.Unavailable`, connection errors) → invalidate, if lookup is empty wait with `waitForChange(pollIntervalMs)` until `waitForAgentMs` from the first miss, then `AgentUnavailableError`; `fatal` (`InvalidArgument`, `NotFound`, `PermissionDenied`, `FailedPrecondition`, everything else) → rethrow. Server-stream input is buffered so it can be resent. Retries keep the caller's headers (`Sbx-Request-Id`) unchanged.
- `attach.ts`:
  ```ts
  export type AttachView =
    | { kind: "data"; stream: string; offset: bigint; data: Uint8Array }
    | { kind: "truncated"; stream: string; availableFrom: bigint }
    | { kind: "exit"; ends: Record<string, bigint> }
    | { kind: "other" };
  export type AttachOutput<E> =
    | { type: "data"; stream: string; offset: bigint; data: Uint8Array }
    | { type: "truncated"; stream: string; availableFrom: bigint }
    | { type: "exit"; event: E }
    | { type: "other"; event: E };
  export function resumableAttach<E>(opts: {
    open: (offsets: Record<string, bigint>, signal: AbortSignal) => AsyncIterable<E>; // Run first, Attach after
    view: (ev: E) => AttachView;
    offsets: Record<string, bigint>;
    signal?: AbortSignal;
    maxAttempts?: number; // consecutive failures without progress, default 20
  }): AsyncGenerator<AttachOutput<E>>;
  ```
  Per stream: `offset == expected` → yield, advance; overlap → trim prefix, yield rest (drop if nothing left); gap → abort the current stream and reopen from `expected`; `truncated` → yield, `expected = availableFrom`; `exit` → if every `ends[s] == expected[s]` yield and finish, else reopen; retryable errors (`classify != "fatal"`) → reopen from `expected`; fatal → throw.

- [ ] **Step 1: Failing tests:**
  - `pg-registry.test.ts` (Postgres via `helpers/pg.ts`: env `SBX_TEST_DATABASE_URL` or Docker `postgres:18.6-alpine`, applies `libs/tunnel/registry/migrations/*.sql`): lookup connected session returns route; stale instance → `undefined` (Review Focus 5); disconnected → `undefined`; cache served without DB hit until a NOTIFY (update row → next lookup sees the new instance within 1 s); `waitForChange` resolves on NOTIFY before timeout and on timeout otherwise.
  - `transport.test.ts` with `helpers/fake-gateway.ts` (Node `http2` servers using `connectNodeAdapter` and the generated `sbx.testing.v1` service under prefix `/v1/machines/<id>/rpc`, plus scripted 421/503 responses with the same headers and JSON bodies as Task 8): unary succeeds; 421 → second attempt hits the URL from `sbx-instance-url` with the same `sbx-request-id`; 503 `agent_unavailable` then registry change → succeeds after `waitForChange`; never connected → `AgentUnavailableError` after `waitForAgentMs` (test 300 ms) with `retryable === true`; `InvalidArgument` → thrown on first attempt (one request seen by the server); stream 421 before headers → retried transparently; `requireCapability` → `AgentOutdatedError` when missing.
  - `attach.test.ts` with scripted iterables: exact pass-through; overlap trimmed; gap triggers reopen from expected (assert `open` offsets); truncated advances expected; exit with matching ends finishes; exit with lagging ends reopens; retryable error mid-stream reopens; fatal error throws; more than `maxAttempts` failures without progress throws.
- [ ] **Step 2:** `pnpm --filter @sbx/agent-client test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @sbx/agent-client test` PASS; `pnpm lint` and `pnpm -r typecheck` clean.
- [ ] **Step 5:** Commit `agent-client: registry lookup, routing transport, resumable attach`.

### Task 12: Cross-language e2e (TS agent-client ↔ Go gateway and agent)

**Files:** Create `libs/tunnel/internal/cmd/tunnelharness/main.go`, `packages/agent-client/test/e2e.test.ts`, `packages/agent-client/test/helpers/harness.ts`.

**Interfaces:**
- `tunnelharness` flags: `-db <dsn>` (migrates), `-gateways 2`, `-agents 1`, `-token <service token>`; starts gateways (internal listeners on `127.0.0.1:0` with h2c + HTTP/1.1, shrunk timings), memnet, agents with `process.Store`; prints one JSON line `{"machines":["<uuid>"],"gateways":[{"id","url"}],"control":"http://127.0.0.1:<port>"}`; control `POST /fault` body `{"kind":"cut"|"stall"|"drain"|"kill-gateway"|"restart-agent","machine":"<uuid>"}` → 200 after injecting (drain/kill also start a replacement gateway). Exits on stdin EOF.
- `helpers/harness.ts`: builds the harness once (`mise exec -- go build -o <tmp>`), spawns it, parses the JSON line, `fault(kind, machine)`, `stop()`.

- [ ] **Step 1: Failing test** `e2e.test.ts`: `PgRegistry` + `AgentClient` against the harness; `Run` of a command (3000 lines × 512 B, 1 ms, exit 42) consumed with `resumableAttach` (`open` = `Run` first, then `Attach` with offsets); a second reader attaches by `commandId` from offset 0; a loop injects a random fault every 100–400 ms until exit. Assert: both readers' sha256 of stdout and stderr equal the expected (computed in TS from the same line formula), exit code 42, `SetLabel` with one request id returns `calls == 1` after faults, no call rejected except retryable errors that were retried.
- [ ] **Step 2:** FAIL. **Step 3:** implement harness and helper; fix bugs found (with focused tests in the owning package).
- [ ] **Step 4:** `pnpm --filter @sbx/agent-client test` PASS three times in a row; Go `go test ./...` and lint still clean.
- [ ] **Step 5:** Commit `tunnel: cross-language e2e harness and agent-client e2e test`.

### Final verification

- [ ] `cd proto && buf lint`; regenerate → `git status` clean.
- [ ] `libs/proto`, `libs/tunnel`: `go test -race ./...`, `golangci-lint run ./...`, Windows amd64/arm64 builds and `go vet`.
- [ ] `pnpm install --frozen-lockfile && pnpm lint && pnpm -r typecheck && pnpm -r test`.
- [ ] Push `git push -u origin s2-impl`.
