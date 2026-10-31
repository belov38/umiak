package desktop

import (
	"context"
	"errors"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// PendingStreamer fails closed until upstream pairing is verified on pve.
// Its interface is also implemented by fake streamers and the future OS adapter.
type PendingStreamer struct{}

// Open explicitly reports unavailable instead of simulating a working video stream.
func (PendingStreamer) Open(context.Context, Credentials, []*v1.DesktopIceServer) (string, string, error) {
	return "", "", errors.New("desktop: upstream pairing awaits pve spike")
}

// Stop has no processes to stop.
func (PendingStreamer) Stop(context.Context) error { return nil }

// EndStreams has no viewers to disconnect.
func (PendingStreamer) EndStreams(context.Context) error { return nil }
