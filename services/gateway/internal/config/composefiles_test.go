package config

import (
	"os"
	"strings"
	"testing"
)

// The dev stack runs the gateway as uid 65532 while the key is owned by the
// quickstart user, and has no owner ingress: it must leave the feature off.
func TestDevComposeLeavesIngressDesktopKeyUnset(t *testing.T) {
	b, err := os.ReadFile("../../../../deploy/compose/gateway.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "INGRESS_DESKTOP_KEY_FILE") {
		t.Fatal("deploy/compose/gateway.yaml must not set UMIAK_GATEWAY_INGRESS_DESKTOP_KEY_FILE")
	}
}
