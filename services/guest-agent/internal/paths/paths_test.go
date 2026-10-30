package paths

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Each OS test file defines emptyFields: the fields of the other OS, which
// are empty in this one.

func TestForRootPrefixesEveryPath(t *testing.T) {
	root := t.TempDir()
	v := reflect.ValueOf(ForRoot(root))
	for i := range v.NumField() {
		if !v.Type().Field(i).IsExported() {
			continue
		}
		name := v.Type().Field(i).Name
		got := v.Field(i).String()
		if emptyFields[name] {
			if got != "" {
				t.Errorf("%s = %q, want empty on this OS", name, got)
			}
			continue
		}
		if !strings.HasPrefix(got, root+string(filepath.Separator)) {
			t.Errorf("%s = %q, want prefix %q", name, got, root)
		}
	}
}

func TestDefaultFieldsAreAbsoluteAndDistinct(t *testing.T) {
	v := reflect.ValueOf(Default())
	seen := map[string]string{}
	for i := range v.NumField() {
		if !v.Type().Field(i).IsExported() {
			continue
		}
		name := v.Type().Field(i).Name
		got := v.Field(i).String()
		if emptyFields[name] {
			if got != "" {
				t.Errorf("%s = %q, want empty on this OS", name, got)
			}
			continue
		}
		if !filepath.IsAbs(got) {
			t.Errorf("%s = %q is not absolute", name, got)
		}
		if prev, dup := seen[got]; dup {
			t.Errorf("%s and %s share %q", prev, name, got)
		}
		seen[got] = name
	}
}
