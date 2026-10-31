package ports

import (
	"slices"
	"strings"
)

// filterListeners drops the listeners on excludePorts and those whose
// process image name equals (case-insensitively) one of excludeProcs. It
// returns a new slice; listeners without a known process are only subject
// to the port filter.
func filterListeners(ls []Listener, excludePorts []uint32, excludeProcs []string) []Listener {
	out := make([]Listener, 0, len(ls))
	for _, l := range ls {
		if slices.Contains(excludePorts, uint32(l.Port)) {
			continue
		}
		if l.Process != "" && slices.ContainsFunc(excludeProcs, func(p string) bool {
			return strings.EqualFold(p, l.Process)
		}) {
			continue
		}
		out = append(out, l)
	}
	return out
}
