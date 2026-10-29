package reqcache_test

import (
	"errors"

	"connectrpc.com/connect"
)

func errsString(s string) error { return errors.New(s) }

func asConnect(err error, target **connect.Error) bool { return errors.As(err, target) }
