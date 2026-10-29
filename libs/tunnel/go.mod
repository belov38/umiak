module github.com/belov38/boat-dev-clone/libs/tunnel

go 1.27

toolchain go1.27.3

require (
	connectrpc.com/connect v1.21.1
	github.com/belov38/boat-dev-clone/libs/proto v0.0.0
	github.com/coder/websocket v1.8.15
	github.com/google/uuid v1.6.0
	golang.org/x/net v0.62.0
	golang.org/x/sys v0.49.0
	google.golang.org/protobuf v1.36.12
)

require golang.org/x/text v0.43.0 // indirect

replace github.com/belov38/boat-dev-clone/libs/proto => ../proto
