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
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.11.0
	github.com/pelletier/go-toml/v2 v2.4.3
	github.com/shirou/gopsutil/v4 v4.26.9
	go.etcd.io/bbolt v1.5.0
	golang.org/x/crypto v0.58.0
	golang.org/x/sys v0.49.0
	google.golang.org/protobuf v1.36.12
)

require (
	github.com/coder/websocket v1.8.15 // indirect
	github.com/ebitengine/purego v0.11.1 // indirect
	github.com/go-ole/go-ole v1.2.6 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/lufia/plan9stats v0.0.0-20211012122336-39d0f177ccd0 // indirect
	github.com/power-devops/perfstat v0.0.0-20260805114148-88456608a4f6 // indirect
	github.com/tklauser/go-sysconf v0.4.0 // indirect
	github.com/tklauser/numcpus v0.12.0 // indirect
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
	golang.org/x/sync v0.24.0 // indirect
	golang.org/x/text v0.43.0 // indirect
)

replace github.com/belov38/boat-dev-clone/libs/proto => ../../libs/proto

replace github.com/belov38/boat-dev-clone/libs/tunnel => ../../libs/tunnel
