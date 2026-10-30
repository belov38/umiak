package wincmd

import (
	"slices"
	"strings"
)

// MergeEnv merges KEY=VALUE layers; later layers win. Keys compare
// case-insensitively, as Windows does, and keep the spelling under which
// they first appeared (Path from the system block stays Path when a later
// layer sets PATH). Entries without a key are dropped; keys may start with
// '=' (the hidden per-drive directories such as =C:). The result is sorted
// case-insensitively, the order CreateProcess expects.
func MergeEnv(layers ...[]string) []string {
	type entry struct{ key, value string }
	byKey := map[string]*entry{}
	for _, layer := range layers {
		for _, kv := range layer {
			k, v, ok := splitEnv(kv)
			if !ok {
				continue
			}
			uk := strings.ToUpper(k)
			if e, ok := byKey[uk]; ok {
				e.value = v
				continue
			}
			byKey[uk] = &entry{key: k, value: v}
		}
	}
	keys := make([]string, 0, len(byKey))
	for uk := range byKey {
		keys = append(keys, uk)
	}
	slices.Sort(keys)
	out := make([]string, 0, len(keys))
	for _, uk := range keys {
		e := byKey[uk]
		out = append(out, e.key+"="+e.value)
	}
	return out
}

// Lookup returns the value of key in env, comparing keys case-insensitively;
// the last match wins.
func Lookup(env []string, key string) (string, bool) {
	val, found := "", false
	for _, kv := range env {
		if k, v, ok := splitEnv(kv); ok && strings.EqualFold(k, key) {
			val, found = v, true
		}
	}
	return val, found
}

// splitEnv splits KEY=VALUE at the first '=' after the first character.
func splitEnv(kv string) (key, value string, ok bool) {
	if kv == "" {
		return "", "", false
	}
	i := strings.IndexByte(kv[1:], '=')
	if i < 0 {
		return "", "", false
	}
	return kv[:i+1], kv[i+2:], true
}
