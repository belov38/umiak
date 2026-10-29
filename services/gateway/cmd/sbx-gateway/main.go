// Command sbx-gateway is the edge of the sandbox platform: HTTPS preview
// proxy, SSH gateway and the tunnel endpoint for guest agents.
package main

import (
	"fmt"
	"os"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/config"
)

// version is set with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 1 {
		switch args[0] {
		case "version":
			fmt.Println(version)
			return 0
		case "check-config":
			if _, err := config.FromEnv(os.Getenv); err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 1
			}
			return 0
		}
	}
	fmt.Fprintln(os.Stderr, "usage: sbx-gateway version | check-config")
	return 2
}
