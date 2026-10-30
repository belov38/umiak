//go:build windows

package output_test

// punchUnit is the eviction granularity of the store under test: NTFS frees
// sparse data in 64 KiB units.
const punchUnit = 64 << 10
