package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/agent"
)

// envTimeout bounds `sbx-agent env`: an SSH login waits for it.
const envTimeout = 10 * time.Second

// envCmd implements `sbx-agent env [--format pwsh|cmd|sh]`: the session
// env of the agent (S9 spec 12.7) from the env socket, as assignments for
// the shell of an SSH session (the pwsh profile parses its output).
func envCmd(ctx context.Context, d deps, args []string, stdout, stderr io.Writer) int {
	def := "sh"
	if runtime.GOOS == "windows" {
		def = "pwsh"
	}
	fs := flag.NewFlagSet("env", flag.ContinueOnError)
	fs.SetOutput(stderr)
	format := fs.String("format", def, "pwsh, cmd (a batch file) or sh")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || !validEnvFormat(*format) {
		_, _ = io.WriteString(stderr, "usage: sbx-agent env [--format pwsh|cmd|sh]\n")
		return exitUsage
	}
	if d.layout.EnvSocket == "" {
		_, _ = io.WriteString(stderr, "sbx-agent env: no env socket on this OS (Windows only; Linux sessions read /etc/sbx/env)\n")
		return exitUsage
	}
	env, err := fetchEnv(ctx, d.layout.EnvSocket)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent env: %v\n", err)
		return 1
	}
	if err := formatEnv(stdout, stderr, *format, env); err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent env: %v\n", err)
		return 1
	}
	return 0
}

// fetchEnv reads the session env from the env socket.
func fetchEnv(ctx context.Context, sock string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, envTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, agentURL+agent.EnvPath, nil)
	if err != nil {
		return nil, err
	}
	res, err := socketClient(sock).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("env socket: %s", res.Status)
	}
	var er agent.EnvResponse
	if err := json.NewDecoder(res.Body).Decode(&er); err != nil {
		return nil, fmt.Errorf("env socket: %w", err)
	}
	return er.Env, nil
}

func validEnvFormat(f string) bool {
	return f == "pwsh" || f == "cmd" || f == "sh"
}

var (
	// pwshPlainName is a name $env:NAME takes without braces.
	pwshPlainName = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	// shName is a name a POSIX shell can export.
	shName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	// pwshQuote doubles the characters PowerShell takes as a single quote
	// (the ASCII one and U+2018..U+201B) inside a single-quoted string.
	pwshQuote = strings.NewReplacer("'", "''", "‘", "‘‘", "’", "’’", "‚", "‚‚", "‛", "‛‛")
	// pwshBraced escapes a name inside ${env:...}.
	pwshBraced = strings.NewReplacer("`", "``", "{", "`{", "}", "`}")
)

// formatEnv writes the KEY=VALUE entries env as assignments in format:
//
//	pwsh: $env:K = 'v' (${env:K} for other names; quotes doubled)
//	cmd:  set "K=v"    (% doubled, for a batch file)
//	sh:   export K='v'
//
// Entries a format cannot carry (a line break in a cmd value or a name,
// a name sh cannot export) are skipped with a note on stderr.
func formatEnv(w, stderr io.Writer, format string, env []string) error {
	if !validEnvFormat(format) {
		return fmt.Errorf("unknown format %q", format)
	}
	var b strings.Builder
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			continue
		}
		if strings.ContainsAny(k, "\r\n") {
			_, _ = fmt.Fprintf(stderr, "sbx-agent env: skipped a name with a line break\n")
			continue
		}
		switch format {
		case "pwsh":
			name := "$env:" + k
			if !pwshPlainName.MatchString(k) {
				name = "${env:" + pwshBraced.Replace(k) + "}"
			}
			b.WriteString(name + " = '" + pwshQuote.Replace(v) + "'\n")
		case "cmd":
			if strings.ContainsAny(v, "\r\n") {
				_, _ = fmt.Fprintf(stderr, "sbx-agent env: skipped %s: cmd cannot hold a line break\n", k)
				continue
			}
			b.WriteString(`set "` + strings.ReplaceAll(k+"="+v, "%", "%%") + "\"\n")
		case "sh":
			if !shName.MatchString(k) {
				_, _ = fmt.Fprintf(stderr, "sbx-agent env: skipped %s: not a shell variable name\n", k)
				continue
			}
			b.WriteString("export " + k + "='" + strings.ReplaceAll(v, "'", `'\''`) + "'\n")
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}
