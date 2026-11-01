// Package pgtest provides a Postgres instance and per-test databases for
// tests. It is test support only and must not be imported by library code.
//
// Usage: call Main from the package's TestMain, then New(t) in each test.
// If UMIAK_TEST_DATABASE_URL is set it is used as the admin connection string
// (a postgres:// URL). Otherwise a postgres container is started once per
// test binary through the docker CLI. UMIAK_TEST_SKIP_PG=1 makes New skip the
// test instead of failing when no database is available.
package pgtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	envURL  = "UMIAK_TEST_DATABASE_URL"
	envSkip = "UMIAK_TEST_SKIP_PG"
	image   = "postgres:18.6-alpine"
)

var (
	mu       sync.Mutex
	adminDSN string // set by Main when it started a container
	startErr error  // set by Main when the container could not be started
	skipPG   bool
)

// Main starts the shared Postgres container when needed, runs the tests and
// removes the container. Call it from TestMain: func TestMain(m *testing.M) { pgtest.Main(m) }.
func Main(m *testing.M) {
	os.Exit(run(m))
}

func run(m *testing.M) int {
	var containerID string
	switch {
	case os.Getenv(envURL) != "":
		// Use the external database as is.
	case os.Getenv(envSkip) == "1":
		skipPG = true
	default:
		id, dsn, err := startContainer()
		containerID = id
		mu.Lock()
		adminDSN, startErr = dsn, err
		mu.Unlock()
	}
	code := m.Run()
	if containerID != "" {
		// Best effort: --rm removes the container once it stops.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_ = exec.CommandContext(ctx, "docker", "rm", "-f", containerID).Run()
		cancel()
	}
	return code
}

func startContainer() (id, dsn string, err error) {
	docker, err := exec.LookPath("docker")
	if err != nil {
		return "", "", fmt.Errorf("docker not found in PATH and %s is not set (set %s=1 to skip database tests): %w", envURL, envSkip, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute) // the image may need a pull
	defer cancel()
	out, err := exec.CommandContext(ctx, docker, "run", "-d", "--rm",
		"-e", "POSTGRES_PASSWORD=umiak",
		"-p", "127.0.0.1::5432", image).Output()
	if err != nil {
		return "", "", fmt.Errorf("docker run %s: %w%s", image, err, stderr(err))
	}
	id = strings.TrimSpace(string(out))
	portOut, err := exec.CommandContext(ctx, docker, "port", id, "5432/tcp").Output()
	if err != nil {
		return id, "", fmt.Errorf("docker port: %w%s", err, stderr(err))
	}
	// Output looks like "127.0.0.1:49153" and may list an IPv6 line too.
	line := strings.TrimSpace(strings.SplitN(string(portOut), "\n", 2)[0])
	idx := strings.LastIndex(line, ":")
	if idx < 0 {
		return id, "", fmt.Errorf("unexpected docker port output %q", portOut)
	}
	dsn = "postgres://postgres:umiak@127.0.0.1:" + line[idx+1:] + "/postgres?sslmode=disable"
	if err := waitReady(dsn, 60*time.Second); err != nil {
		return id, "", err
	}
	return id, dsn, nil
}

func stderr(err error) string {
	var ee *exec.ExitError
	if errors.As(err, &ee) && len(ee.Stderr) > 0 {
		return ": " + strings.TrimSpace(string(ee.Stderr))
	}
	return ""
}

func waitReady(dsn string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		last = ping(ctx, dsn)
		cancel()
		if last == nil {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("postgres not ready after %s: %w", timeout, last)
}

func ping(ctx context.Context, dsn string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	var one int
	return conn.QueryRow(ctx, "SELECT 1").Scan(&one)
}

func admin(t testing.TB) string {
	t.Helper()
	if dsn := os.Getenv(envURL); dsn != "" {
		return dsn
	}
	mu.Lock()
	dsn, err, skip := adminDSN, startErr, skipPG
	mu.Unlock()
	switch {
	case skip || (os.Getenv(envSkip) == "1" && dsn == "" && err == nil):
		t.Skipf("%s=1: skipping test that needs Postgres", envSkip)
	case err != nil:
		t.Fatalf("postgres unavailable: %v", err)
	case dsn == "":
		t.Fatalf("no Postgres: set %s or call pgtest.Main from TestMain (needs docker)", envURL)
	}
	return dsn
}

// New creates a fresh database with the tunnel migrations applied and returns
// a pool connected to it and its connection string. The database is dropped
// when the test ends.
func New(t testing.TB) (*pgxpool.Pool, string) {
	t.Helper()
	adminURL := admin(t)
	ctx := context.Background()

	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		t.Fatalf("random: %v", err)
	}
	name := "umiak_test_" + hex.EncodeToString(rnd[:])

	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}

	u, err := url.Parse(adminURL)
	if err != nil {
		t.Fatalf("parse %s (must be a postgres:// URL): %v", envURL, err)
	}
	u.Path = "/" + name
	dsn := u.String()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		dctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		c, err := pgx.Connect(dctx, adminURL)
		if err != nil {
			t.Errorf("connect admin for drop: %v", err)
			return
		}
		defer func() { _ = c.Close(dctx) }()
		if _, err := c.Exec(dctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("drop database: %v", err)
		}
	})
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return pool, dsn
}

// ApplyMigrations executes db/migrations/01??_*.sql from the repository root
// in file-name order. There is no tracking table: the migration runner owned
// by S6 does the tracking in production.
func ApplyMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	dir, err := migrationsDir()
	if err != nil {
		return err
	}
	files, err := filepath.Glob(filepath.Join(dir, "01??_*.sql"))
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no migrations 01??_*.sql in %s", dir)
	}
	sort.Strings(files)
	for _, f := range files {
		sql, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		// Without arguments pgx uses the simple protocol, so a file may hold
		// several statements.
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("%s: %w", filepath.Base(f), err)
		}
	}
	return nil
}

// migrationsDir walks up from the working directory to find db/migrations.
func migrationsDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for dir := wd; ; {
		cand := filepath.Join(dir, "db", "migrations")
		if st, err := os.Stat(cand); err == nil && st.IsDir() {
			return cand, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("db/migrations not found above %s", wd)
		}
		dir = parent
	}
}
