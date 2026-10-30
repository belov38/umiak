// Package wincmd builds Windows command lines and environments: MSVCRT
// argument quoting, cmd.exe lines for batch files, program lookup through
// PATH and PATHEXT, the pwsh wrapper of shell commands and case-insensitive
// env merging (spec 12.6, 12.7). It is pure string and file logic, so it
// builds and is tested on every platform.
package wincmd

import "strings"

// MaxCommandLine is the longest command line, in UTF-16 code units, the
// agent hands to CreateProcess. The hard limit is 32767; the margin covers
// what the shim may add.
const MaxCommandLine = 32000

// ComposeArgs joins args into a command line that CommandLineToArgvW and
// the MSVCRT parser split back into args. It is a portable copy of
// windows.ComposeCommandLine: args[0] is quoted without escapes (a program
// name cannot hold a quote; quotes in it are dropped), the other arguments
// are escaped by EscapeArg.
func ComposeArgs(args []string) string {
	if len(args) == 0 {
		return ""
	}
	prog := args[0]
	mustQuote := prog == ""
	for i := 0; i < len(prog); i++ {
		if c := prog[i]; c <= ' ' || (c == '"' && i == 0) {
			mustQuote = true
			break
		}
	}
	var b strings.Builder
	if mustQuote {
		b.WriteByte('"')
		b.WriteString(strings.ReplaceAll(prog, `"`, ""))
		b.WriteByte('"')
	} else {
		b.WriteString(prog)
	}
	for _, a := range args[1:] {
		b.WriteByte(' ')
		b.WriteString(EscapeArg(a))
	}
	return b.String()
}

// EscapeArg quotes one argument by the MSVCRT rules (as syscall.EscapeArg):
// backslashes are doubled only before a quote, quotes are escaped, and the
// argument is wrapped in quotes when empty or holding a space or tab.
func EscapeArg(s string) string {
	if s == "" {
		return `""`
	}
	if !strings.ContainsAny(s, "\"\\ \t") {
		return s
	}
	quote := strings.ContainsAny(s, " \t")
	var b strings.Builder
	if quote {
		b.WriteByte('"')
	}
	slashes := 0
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\\':
			slashes++
		case '"':
			b.WriteString(strings.Repeat(`\`, slashes+1))
			slashes = 0
		default:
			slashes = 0
		}
		b.WriteByte(s[i])
	}
	if quote {
		b.WriteString(strings.Repeat(`\`, slashes))
		b.WriteByte('"')
	}
	return b.String()
}
