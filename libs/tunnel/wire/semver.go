package wire

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type semver struct {
	major, minor, patch uint64
	pre                 []string
}

// CompareVersions compares two MAJOR.MINOR.PATCH[-pre][+build] versions with an
// optional "v" prefix using semver precedence. It returns -1, 0 or 1. Build
// metadata is ignored.
func CompareVersions(a, b string) (int, error) {
	va, err := parseSemver(a)
	if err != nil {
		return 0, err
	}
	vb, err := parseSemver(b)
	if err != nil {
		return 0, err
	}
	for _, p := range [][2]uint64{{va.major, vb.major}, {va.minor, vb.minor}, {va.patch, vb.patch}} {
		if c := cmpUint(p[0], p[1]); c != 0 {
			return c, nil
		}
	}
	return comparePre(va.pre, vb.pre), nil
}

func parseSemver(s string) (semver, error) {
	orig := s
	s = strings.TrimPrefix(s, "v")
	s, _, _ = strings.Cut(s, "+")
	core, pre, hasPre := strings.Cut(s, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return semver{}, fmt.Errorf("invalid version %q", orig)
	}
	var nums [3]uint64
	for i, p := range parts {
		n, ok := parseNumeric(p)
		if !ok {
			return semver{}, fmt.Errorf("invalid version %q", orig)
		}
		nums[i] = n
	}
	v := semver{major: nums[0], minor: nums[1], patch: nums[2]}
	if hasPre {
		v.pre = strings.Split(pre, ".")
		for _, id := range v.pre {
			if err := checkPreIdentifier(id); err != nil {
				return semver{}, fmt.Errorf("invalid version %q: %w", orig, err)
			}
		}
	}
	return v, nil
}

// parseNumeric parses a non-negative decimal without leading zeros.
func parseNumeric(s string) (uint64, bool) {
	if s == "" || (len(s) > 1 && s[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(s, 10, 64)
	return n, err == nil
}

func checkPreIdentifier(id string) error {
	if id == "" {
		return errors.New("empty pre-release identifier")
	}
	numeric := true
	for _, c := range id {
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '-':
			numeric = false
		default:
			return errors.New("invalid pre-release identifier")
		}
	}
	if numeric {
		if _, ok := parseNumeric(id); !ok {
			return errors.New("numeric pre-release identifier with leading zero")
		}
	}
	return nil
}

func comparePre(a, b []string) int {
	// A version without pre-release has higher precedence.
	switch {
	case len(a) == 0 && len(b) == 0:
		return 0
	case len(a) == 0:
		return 1
	case len(b) == 0:
		return -1
	}
	for i := 0; i < len(a) && i < len(b); i++ {
		if c := compareIdentifier(a[i], b[i]); c != 0 {
			return c
		}
	}
	return cmpUint(uint64(len(a)), uint64(len(b)))
}

func compareIdentifier(a, b string) int {
	na, aNum := parseNumeric(a)
	nb, bNum := parseNumeric(b)
	switch {
	case aNum && bNum:
		return cmpUint(na, nb)
	case aNum:
		return -1 // numeric identifiers sort before alphanumeric ones
	case bNum:
		return 1
	}
	return strings.Compare(a, b)
}

func cmpUint(a, b uint64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
