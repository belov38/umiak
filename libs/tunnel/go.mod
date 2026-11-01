module github.com/belov38/umiak/libs/tunnel

go 1.27

toolchain go1.27.3

require (
	connectrpc.com/connect v1.21.1
	github.com/belov38/umiak/libs/proto v0.0.0
	github.com/coder/websocket v1.8.15
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.11.0
	golang.org/x/net v0.62.0
	golang.org/x/sync v0.24.0
	golang.org/x/sys v0.49.0
	google.golang.org/protobuf v1.36.12
)

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/text v0.43.0 // indirect
)

replace github.com/belov38/umiak/libs/proto => ../proto
