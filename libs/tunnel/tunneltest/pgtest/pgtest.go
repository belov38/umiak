// Package pgtest gives other modules of the repository the shared Postgres
// test support of this module. It is test support only and must not be
// imported by non-test code. See the internal pgtest package for the
// environment variables.
package pgtest

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/belov38/boat-dev-clone/libs/tunnel/internal/pgtest"
)

// Main starts the shared Postgres container when needed, runs the tests and
// removes the container. Call it from TestMain.
func Main(m *testing.M) {
	pgtest.Main(m)
}

// New creates a database with the tunnel migrations applied and returns a pool
// and its connection string. The database is dropped when the test ends.
func New(t testing.TB) (*pgxpool.Pool, string) {
	t.Helper()
	return pgtest.New(t)
}
