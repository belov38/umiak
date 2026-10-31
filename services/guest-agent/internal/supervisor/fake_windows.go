package supervisor

import "context"

// LaunchSpec implements SpecLauncher: on Windows the Fake takes the spec
// with the launch like the Windows supervisor, since the Windows layout has
// no CmdSpec directory for Launch to read it from.
func (f *Fake) LaunchSpec(ctx context.Context, id, shimPath string, extraArgs []string, spec []byte) error {
	return FakeSpecLauncher{Fake: f}.LaunchSpec(ctx, id, shimPath, extraArgs, spec)
}
