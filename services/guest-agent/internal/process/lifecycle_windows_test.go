package process

import (
	"context"
	"errors"
)

// LaunchSpec is Launch for the spec launch of the Windows Fake, which the
// manager prefers: without it the promoted Fake.LaunchSpec would bypass the
// failure.
func (s *failingSup) LaunchSpec(ctx context.Context, id, shimPath string, extra []string, spec []byte) error {
	if s.fail.Load() {
		s.st.SetFrozen(true)
		return errors.New("dbus gone")
	}
	return s.Fake.LaunchSpec(ctx, id, shimPath, extra, spec)
}
