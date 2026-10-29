module github.com/belov38/boat-dev-clone/services/guest-agent

go 1.27

toolchain go1.27.3

require (
	connectrpc.com/connect v1.21.1
	github.com/belov38/boat-dev-clone/libs/proto v0.0.0
	github.com/belov38/boat-dev-clone/libs/tunnel v0.0.0
	github.com/coreos/go-systemd/v22 v22.7.0
	github.com/creack/pty v1.1.24
	github.com/fsnotify/fsnotify v1.10.1
	github.com/godbus/dbus/v5 v5.2.4
	github.com/pelletier/go-toml/v2 v2.4.3
	go.etcd.io/bbolt v1.5.0
	golang.org/x/crypto v0.58.0
	golang.org/x/sys v0.49.0
	google.golang.org/protobuf v1.36.12
)

require github.com/google/uuid v1.6.0 // indirect

replace github.com/belov38/boat-dev-clone/libs/proto => ../../libs/proto

replace github.com/belov38/boat-dev-clone/libs/tunnel => ../../libs/tunnel
