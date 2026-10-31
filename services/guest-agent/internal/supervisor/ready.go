package supervisor

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
)

// readReady reads the first line a Windows shim prints on its stdout:
// shim.ReadyLine is success, shim.FailPrefix carries the reason it could
// not start (ErrUnitExists when another shim owns the command), anything
// else or EOF before a line means the shim died.
func readReady(r io.Reader) error {
	line, err := bufio.NewReader(r).ReadString('\n')
	switch {
	case err == nil:
	case errors.Is(err, io.EOF) && line == "":
		return errors.New("supervisor: shim exited before it was ready")
	case errors.Is(err, io.EOF):
		// A line without its newline: the shim died while writing it.
		return fmt.Errorf("supervisor: shim exited before it was ready (partial line %q)", line)
	default:
		return fmt.Errorf("supervisor: read shim readiness: %w", err)
	}
	line = strings.TrimRight(line, "\r\n")
	switch {
	case line == shim.ReadyLine:
		return nil
	case strings.HasPrefix(line, shim.FailPrefix):
		reason := strings.TrimPrefix(line, shim.FailPrefix)
		if strings.HasPrefix(reason, shim.FailAlreadyStarted) {
			return fmt.Errorf("%w: %s", ErrUnitExists, reason)
		}
		return fmt.Errorf("supervisor: shim failed: %s", reason)
	}
	return fmt.Errorf("supervisor: unexpected shim output %q", line)
}
