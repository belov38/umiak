package wincmd

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestComposeArgs(t *testing.T) {
	tests := []struct {
		args []string
		want string
	}{
		{nil, ""},
		{[]string{"prog"}, "prog"},
		{[]string{""}, `""`},
		{[]string{`C:\Program Files\x.exe`, "a"}, `"C:\Program Files\x.exe" a`},
		{[]string{`"quoted"prog`, "a"}, `"quotedprog" a`},
		{[]string{"p", ""}, `p ""`},
		{[]string{"p", "a b"}, `p "a b"`},
		{[]string{"p", "a\tb"}, "p \"a\tb\""},
		{[]string{"p", `say "hi"`}, `p "say \"hi\""`},
		{[]string{"p", `a"b`}, `p a\"b`},
		{[]string{"p", `C:\dir\`}, `p C:\dir\`},
		{[]string{"p", `C:\my dir\`}, `p "C:\my dir\\"`},
		{[]string{"p", `C:\my dir\\`}, `p "C:\my dir\\\\"`},
		{[]string{"p", `a\\"b`}, `p a\\\\\"b`},
		{[]string{"p", `\\server\share`}, `p \\server\share`},
		{[]string{"p", "%PATH%", "&", "|"}, `p %PATH% & |`},
	}
	for _, tt := range tests {
		if got := ComposeArgs(tt.args); got != tt.want {
			t.Errorf("ComposeArgs(%q) = %s, want %s", tt.args, got, tt.want)
		}
	}
}

func TestBatchCommandLineSafe(t *testing.T) {
	tests := []struct {
		script string
		args   []string
		want   string
	}{
		{`C:\nodejs\npm.cmd`, nil, `cmd.exe /d /s /c ""C:\nodejs\npm.cmd""`},
		{`C:\nodejs\npm.cmd`, []string{"install", "left-pad"}, `cmd.exe /d /s /c ""C:\nodejs\npm.cmd" install left-pad"`},
		{`C:\Program Files\nodejs\npx.cmd`, []string{"a b", "", "x&y", "p|q", "<in>", "(sub)", "k=v", "a,b", "a;b", `C:\x\y`},
			`cmd.exe /d /s /c ""C:\Program Files\nodejs\npx.cmd" "a b" "" "x&y" "p|q" "<in>" "(sub)" "k=v" "a,b" "a;b" C:\x\y"`},
		{`C:\t\run.bat`, []string{"plain", "--flag=1", "a\tb"}, "cmd.exe /d /s /c \"\"C:\\t\\run.bat\" plain \"--flag=1\" \"a\tb\"\""},
	}
	for _, tt := range tests {
		got, err := BatchCommandLine(tt.script, tt.args)
		if err != nil {
			t.Errorf("BatchCommandLine(%q, %q): %v", tt.script, tt.args, err)
			continue
		}
		if got != tt.want {
			t.Errorf("BatchCommandLine(%q, %q) =\n  %s\nwant\n  %s", tt.script, tt.args, got, tt.want)
		}
	}
}

func TestBatchCommandLineRejects(t *testing.T) {
	for _, arg := range []string{"%PATH%", "50%", "hi!", `say "x"`, "a\rb", "a\nb", "a^b", `C:\dir\`, `"`} {
		if _, err := BatchCommandLine(`C:\x\npm.cmd`, []string{"ok", arg}); !errors.Is(err, ErrUnsafeBatchArgs) {
			t.Errorf("arg %q: err = %v, want ErrUnsafeBatchArgs", arg, err)
		}
	}
	for _, script := range []string{`C:\%x%\npm.cmd`, `C:\x!\npm.cmd`, "C:\\x\n\\npm.cmd"} {
		if _, err := BatchCommandLine(script, nil); !errors.Is(err, ErrUnsafeBatchArgs) {
			t.Errorf("script %q: err = %v, want ErrUnsafeBatchArgs", script, err)
		}
	}
}

func TestIsBatch(t *testing.T) {
	for p, want := range map[string]bool{
		`C:\x\npm.cmd`: true, `C:\x\NPM.CMD`: true, `C:\x\run.Bat`: true,
		`C:\x\node.exe`: false, `C:\x.cmd\node`: false, "npm": false,
		// Win32 strips trailing dots and spaces: these run through cmd.exe.
		`C:\x\npm.cmd.`: true, `C:\x\npm.cmd `: true, `C:\x\npm.cmd. . `: true, `C:\x\run.bat...`: true,
		`C:\x\node.exe.`: false,
	} {
		if got := IsBatch(p); got != want {
			t.Errorf("IsBatch(%q) = %v, want %v", p, got, want)
		}
	}
}

// touch creates an empty file in dir.
func touch(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestResolveProgramPathext(t *testing.T) {
	bin1, bin2, cwd := t.TempDir(), t.TempDir(), t.TempDir()
	npm := touch(t, bin2, "npm.cmd")
	node := touch(t, bin1, "node.exe")
	touch(t, bin2, "node.exe")     // shadowed by bin1
	tool := touch(t, bin1, "tool") // without an extension it is never run
	toolExe := touch(t, bin1, "tool.exe")
	local := touch(t, cwd, "local.bat")
	if err := os.Mkdir(filepath.Join(bin1, "dir.exe"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Keys are case-insensitive; an empty, relative and quoted entry are
	// skipped or unquoted.
	env := []string{
		"Path=;relative;\"" + bin1 + "\";" + bin2,
		"PathExt=.COM;.EXE;.BAT;.CMD",
	}

	tests := []struct {
		name      string
		wantPath  string
		wantBatch bool
	}{
		{"npm", npm, true},
		{"npm.cmd", npm, true},
		{"node", node, false},
		{"node.exe", node, false},
		{"tool", toolExe, false},
		{"tool.exe", toolExe, false},
		{"dir", "", false},
		{"local", "", false},
		{"missing", "", false},
		{filepath.Join(cwd, "local"), local, true},
		{filepath.Join(cwd, "local.bat"), local, true},
		{"local.bat", "", false},
		{"." + string(filepath.Separator) + "local", local, true},
		// Trailing dots and spaces name the same file and are dropped.
		{"npm.cmd.", npm, true},
		{"npm.cmd ", npm, true},
		{"npm.cmd. .", npm, true},
		{"node.exe.", node, false},
		{filepath.Join(bin2, "npm.cmd.."), npm, true},
		{".", "", false},
		{"npm.cmd::$DATA", "", false},
		{filepath.Join(bin1, "tool"), toolExe, false},
		{tool, toolExe, false},
	}
	for _, tt := range tests {
		got, batch, err := ResolveProgram(tt.name, env, cwd)
		if tt.wantPath == "" {
			if !errors.Is(err, ErrNotFound) {
				t.Errorf("ResolveProgram(%q) = %q, %v; want ErrNotFound", tt.name, got, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("ResolveProgram(%q): %v", tt.name, err)
			continue
		}
		// Case-insensitive file systems answer a stat of NPM.cmd too.
		if !strings.EqualFold(got, tt.wantPath) || batch != tt.wantBatch {
			t.Errorf("ResolveProgram(%q) = %q, %v; want %q, %v", tt.name, got, batch, tt.wantPath, tt.wantBatch)
		}
	}
}

func TestResolveProgramPathextTrailingDot(t *testing.T) {
	bin := t.TempDir()
	npm := touch(t, bin, "npm.cmd")
	for _, pe := range []string{".CMD.", ".CMD ", "CMD..", ".EXE;;.;.CMD. "} {
		got, batch, err := ResolveProgram("npm", []string{"PATH=" + bin, "PATHEXT=" + pe}, "")
		if err != nil || !batch || got != npm {
			t.Errorf("PATHEXT=%q: ResolveProgram = %q, %v, %v", pe, got, batch, err)
		}
	}
}

func TestResolveProgramDefaultPathext(t *testing.T) {
	bin := t.TempDir()
	touch(t, bin, "x.bat")
	got, batch, err := ResolveProgram("x", []string{"PATH=" + bin}, "")
	if err != nil || !batch || got != filepath.Join(bin, "x.bat") {
		t.Fatalf("ResolveProgram = %q, %v, %v", got, batch, err)
	}
}

// decodeEncoded reverses -EncodedCommand: base64 of UTF-16LE.
func decodeEncoded(t *testing.T, s string) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	if len(b)%2 != 0 {
		t.Fatalf("odd UTF-16 length %d", len(b))
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[2*i:])
	}
	return string(utf16.Decode(u))
}

const testPwsh = `C:\Program Files\PowerShell\7\pwsh.exe`

func TestPwshArgvEncoded(t *testing.T) {
	script := "Write-Output 'привет 🙂'\n# trailing comment"
	argv, file := PwshArgv(testPwsh, script, false, `C:\state\commands\c1`)
	if file != "" {
		t.Fatalf("short script went to a file: %q", file)
	}
	wantPrefix := []string{testPwsh, "-NoLogo", "-NonInteractive", "-NoProfile", "-EncodedCommand"}
	if len(argv) != len(wantPrefix)+1 || !slices.Equal(argv[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("argv = %q", argv)
	}
	got := decodeEncoded(t, argv[len(argv)-1])
	want := "$global:LASTEXITCODE = 0\n" + script + "\n\n" +
		"$__umiak_ok = $?; if ($__umiak_ok) { exit 0 } elseif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }"
	if got != want {
		t.Fatalf("wrapped script =\n%s\nwant\n%s", got, want)
	}
	if got != WrapScript(script) {
		t.Fatal("WrapScript differs from the encoded script")
	}
	lines := strings.Split(got, "\n")
	if last := lines[len(lines)-1]; !strings.HasPrefix(last, "$__umiak_ok = $?;") || lines[len(lines)-2] != "" {
		t.Fatalf("epilogue is not on its own line after an empty one: %q", lines[len(lines)-2:])
	}

	// A trailing backtick continues the line: the empty line ends the
	// continuation before the epilogue.
	tick := "cmd /c exit 3 `"
	argv, _ = PwshArgv(testPwsh, tick, false, `C:\d`)
	if got := decodeEncoded(t, argv[len(argv)-1]); !strings.Contains(got, tick+"\n\n$__umiak_ok = $?;") {
		t.Fatalf("backtick script = %q", got)
	}

	// login keeps the profile.
	argv, _ = PwshArgv(testPwsh, "exit 7", true, `C:\d`)
	if slices.Contains(argv, "-NoProfile") {
		t.Fatalf("login argv has -NoProfile: %q", argv)
	}
	if !slices.Equal(argv[:4], []string{testPwsh, "-NoLogo", "-NonInteractive", "-EncodedCommand"}) {
		t.Fatalf("login argv = %q", argv)
	}
}

func TestPwshArgvTooLong(t *testing.T) {
	script := "Write-Output " + strings.Repeat("x", 13000)
	argv, file := PwshArgv(testPwsh, script, false, `C:\state\commands\c1`)
	want := []string{testPwsh, "-NoLogo", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `C:\state\commands\c1\script.ps1`}
	if !slices.Equal(argv, want) {
		t.Fatalf("argv = %q, want %q", argv, want)
	}
	if file != WrapScript(script) {
		t.Fatal("script file text is not the wrapped script")
	}
	if len(utf16.Encode([]rune(ComposeArgs(argv)))) > MaxCommandLine {
		t.Fatal("-File command line is too long")
	}

	// The limit counts the whole command line: the longest script that
	// still goes encoded fits, one more character switches to -File.
	n := 11000
	if _, f := PwshArgv(testPwsh, strings.Repeat("y", n), false, `C:\d`); f != "" {
		t.Fatalf("a %d-char script already went to a file", n)
	}
	for ; n <= MaxCommandLine; n++ {
		a, f := PwshArgv(testPwsh, strings.Repeat("y", n+1), false, `C:\d`)
		if f != "" {
			break
		}
		if l := len(utf16.Encode([]rune(ComposeArgs(a)))); l > MaxCommandLine {
			t.Fatalf("encoded command line of %d chars", l)
		}
	}
	if n > MaxCommandLine {
		t.Fatal("never switched to -File")
	}
}

func TestMergeEnvCaseInsensitive(t *testing.T) {
	base := []string{"Path=C:\\Windows", "USERPROFILE=C:\\Users\\user", "=C:=C:\\", "bogus", "TEMP=a"}
	platform := []string{"PATH=C:\\umiak", "UMIAK=1"}
	spec := []string{"temp=b", "Empty="}
	got := MergeEnv(base, platform, spec)
	want := []string{"=C:=C:\\", "Empty=", "Path=C:\\umiak", "TEMP=b", "UMIAK=1", "USERPROFILE=C:\\Users\\user"}
	if !slices.Equal(got, want) {
		t.Fatalf("MergeEnv = %q, want %q", got, want)
	}
	if v, ok := Lookup(got, "path"); !ok || v != `C:\umiak` {
		t.Fatalf("Lookup(path) = %q, %v", v, ok)
	}
	if _, ok := Lookup(got, "nope"); ok {
		t.Fatal("Lookup(nope) found")
	}
}
