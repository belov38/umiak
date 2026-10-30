package wincmd

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// ErrUnsafeBatchArgs is returned for an argument of a .cmd or .bat file
// that cmd.exe would reinterpret (the BatBadBut class). The agent rejects it
// with invalid_argument unsafe_batch_args instead of escaping it.
var ErrUnsafeBatchArgs = errors.New("wincmd: argument cannot be passed to a batch file safely")

// batchUnsafe are the characters cmd.exe expands or reparses even inside
// quotes: %VAR%, !VAR! (delayed expansion), the escape caret, quotes and
// line breaks.
const batchUnsafe = "%!\"^\r\n"

// batchQuote are the characters that need quotes to stay one batch
// argument and not act as cmd.exe operators: whitespace, the parameter
// delimiters ,;= and & | < > ( ).
const batchQuote = " \t\v\f,;=&|<>()"

// IsBatch reports whether path names a .bat or .cmd file, which runs through
// cmd.exe. Trailing dots and spaces do not hide the extension: Win32 strips
// them, so npm.cmd. opens npm.cmd (CVE-2024-43402 class).
func IsBatch(path string) bool {
	ext := strings.ToLower(filepath.Ext(strings.ReplaceAll(win32Name(path), `\`, "/")))
	return ext == ".bat" || ext == ".cmd"
}

// win32Name drops the trailing dots and spaces Win32 strips from the last
// element of a path, unless the element consists of them only (".", "..").
func win32Name(p string) string {
	t := strings.TrimRight(p, ". ")
	if t == "" || strings.HasSuffix(t, `\`) || strings.HasSuffix(t, "/") || strings.HasSuffix(t, ":") {
		return p
	}
	return t
}

// BatchCommandLine returns the command line that runs the batch file script
// with args through cmd.exe: cmd.exe /d /s /c ""<script>" <args>". /d skips
// the AutoRun commands, /s strips only the outer quotes. Arguments with
// spaces or cmd.exe operators are quoted, empty ones become "". Any argument
// cmd.exe would rewrite (see batchUnsafe) or one ending in a backslash
// (which would escape the closing quote for the program the script calls)
// fails with ErrUnsafeBatchArgs; so does a script path with such characters.
// The caller passes the result as the command line of cmd.exe from the
// system directory.
func BatchCommandLine(script string, args []string) (string, error) {
	if strings.ContainsAny(script, batchUnsafe) {
		return "", fmt.Errorf("%w: script path %q", ErrUnsafeBatchArgs, script)
	}
	var b strings.Builder
	b.WriteString(`cmd.exe /d /s /c ""`)
	b.WriteString(script)
	b.WriteByte('"')
	for i, a := range args {
		if strings.ContainsAny(a, batchUnsafe) || strings.HasSuffix(a, `\`) {
			return "", fmt.Errorf("%w: argument %d %q", ErrUnsafeBatchArgs, i+1, a)
		}
		b.WriteByte(' ')
		if a == "" || strings.ContainsAny(a, batchQuote) {
			b.WriteByte('"')
			b.WriteString(a)
			b.WriteByte('"')
		} else {
			b.WriteString(a)
		}
	}
	b.WriteByte('"')
	return b.String(), nil
}
