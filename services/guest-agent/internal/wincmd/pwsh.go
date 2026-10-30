package wincmd

import (
	"encoding/base64"
	"encoding/binary"
	"slices"
	"strings"
	"unicode/utf16"
)

// ScriptFile is the name of the wrapped shell script in the command
// directory when it is too long for -EncodedCommand.
const ScriptFile = "script.ps1"

// Prologue and epilogue of a shell command (spec 12.6). pwsh turns any exit
// code of the last native program other than 0 and 1 into 1; the epilogue
// keeps it. It sits on its own line after an empty one, so neither a
// trailing comment nor a trailing backtick (line continuation) in the
// script can swallow it.
const (
	pwshPrologue = "$global:LASTEXITCODE = 0"
	pwshEpilogue = "$__sbx_ok = $?; if ($__sbx_ok) { exit 0 } elseif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }"
)

// WrapScript returns script between the prologue and the exit-code
// epilogue.
func WrapScript(script string) string {
	return pwshPrologue + "\n" + script + "\n\n" + pwshEpilogue
}

// PwshArgv returns the argv that runs shell script with pwsh: -NoLogo
// -NonInteractive, -NoProfile unless login, and the wrapped script as
// -EncodedCommand (base64 of UTF-16LE). When that command line would be
// longer than MaxCommandLine, argv runs dir\script.ps1 with -File instead
// and scriptFile is the text the caller must write there; otherwise
// scriptFile is empty. -File runs with -ExecutionPolicy Bypass, so a
// LocalMachine or CurrentUser policy that forbids unsigned scripts does not
// block it (-EncodedCommand is not subject to the policy).
func PwshArgv(pwsh, script string, login bool, dir string) (argv []string, scriptFile string) {
	argv = []string{pwsh, "-NoLogo", "-NonInteractive"}
	if !login {
		argv = append(argv, "-NoProfile")
	}
	wrapped := WrapScript(script)
	encoded := append(slices.Clip(argv), "-EncodedCommand", encodeUTF16LE(wrapped))
	if commandLineLen(encoded) <= MaxCommandLine {
		return encoded, ""
	}
	sep := `\`
	if strings.HasSuffix(dir, `\`) || strings.HasSuffix(dir, "/") {
		sep = ""
	}
	return append(slices.Clip(argv), "-ExecutionPolicy", "Bypass", "-File", dir+sep+ScriptFile), wrapped
}

// encodeUTF16LE returns base64 of s in UTF-16LE, the -EncodedCommand form.
func encodeUTF16LE(s string) string {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 2*len(u))
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[2*i:], c)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// commandLineLen is the length of the composed command line in UTF-16 code
// units, the unit of the CreateProcess limit.
func commandLineLen(argv []string) int {
	n := 0
	for _, r := range ComposeArgs(argv) {
		n += utf16.RuneLen(r)
	}
	return n
}
