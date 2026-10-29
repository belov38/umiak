module github.com/belov38/boat-dev-clone/services/guest-agent

go 1.27

toolchain go1.27.3

require (
	connectrpc.com/connect v1.21.1
	github.com/belov38/boat-dev-clone/libs/tunnel v0.0.0
	github.com/pelletier/go-toml/v2 v2.4.3
)

require (
	github.com/belov38/boat-dev-clone/libs/proto v0.0.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

replace github.com/belov38/boat-dev-clone/libs/proto => ../../libs/proto

replace github.com/belov38/boat-dev-clone/libs/tunnel => ../../libs/tunnel
