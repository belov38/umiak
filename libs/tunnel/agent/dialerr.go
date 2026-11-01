package agent

import (
	"context"
	"errors"
	"net"

	"github.com/belov38/umiak/libs/tunnel/wire"
)

// classifyDialError maps a CONNECT target dial error to a wire.DialError*
// value, or "" when it is neither a refusal nor a timeout.
func classifyDialError(err error) string {
	if isConnRefused(err) {
		return wire.DialErrorRefused
	}
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return wire.DialErrorTimeout
	}
	return ""
}
