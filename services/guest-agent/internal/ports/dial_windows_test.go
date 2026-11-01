package ports

import (
	"context"
	"errors"
	"net"
	"os"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/belov38/umiak/libs/tunnel/agent"
)

func TestWSAConnRefusedIsRefusal(t *testing.T) {
	err := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connectex", windows.WSAECONNREFUSED)}
	if !isConnRefusedOS(err) || !isRefused(err) {
		t.Fatalf("%v not recognised as a refusal", err)
	}
	if isTimeout(err) {
		t.Fatalf("%v classified as a timeout", err)
	}
	if isConnRefusedOS(windows.WSAETIMEDOUT) {
		t.Fatal("WSAETIMEDOUT classified as a refusal")
	}
}

func TestDialRefusedFromWinsock(t *testing.T) {
	d := Dialer{dial: func(context.Context, string, string) (net.Conn, error) {
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connectex", windows.WSAECONNREFUSED)}
	}}
	_, err := d.Dial(t.Context(), "127.0.0.1", 1)
	var de *agent.DialError
	if !errors.As(err, &de) || de.Reason != ReasonRefused {
		t.Fatalf("err = %v, want refused DialError", err)
	}
}
