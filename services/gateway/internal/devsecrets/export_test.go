package devsecrets

// SetLchown replaces the chown of existing files; it returns a restore
// function.
func SetLchown(f func(string, int, int) error) (restore func()) {
	prev := lchown
	lchown = f
	return func() { lchown = prev }
}
