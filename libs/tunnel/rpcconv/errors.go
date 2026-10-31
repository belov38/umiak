// Package rpcconv holds the Connect conventions of the tunnel protocol:
// structured error details and the Sbx-Request-Id requirement.
package rpcconv

import (
	"errors"

	"connectrpc.com/connect"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
)

// Retryable reports whether a client may retry a call that failed with code.
func Retryable(code connect.Code) bool {
	return code == connect.CodeUnavailable || code == connect.CodeDeadlineExceeded
}

// NewError builds a Connect error with a tunnelv1.ErrorDetail attached.
func NewError(code connect.Code, detailCode, msg string) *connect.Error {
	return newError(code, detailCode, msg, Retryable(code))
}

// NewRetryableError is NewError with the detail marked retryable whatever
// the code, for conditions a client may retry that are not unavailable
// (such as failed_precondition file_in_use of the Windows agent).
func NewRetryableError(code connect.Code, detailCode, msg string) *connect.Error {
	return newError(code, detailCode, msg, true)
}

func newError(code connect.Code, detailCode, msg string, retryable bool) *connect.Error {
	err := connect.NewError(code, errors.New(msg))
	d, derr := connect.NewErrorDetail(&tunnelv1.ErrorDetail{
		Code:      detailCode,
		Retryable: retryable,
	})
	if derr == nil {
		err.AddDetail(d)
	}
	return err
}

// Detail returns the tunnelv1.ErrorDetail attached to err, if any.
func Detail(err error) (*tunnelv1.ErrorDetail, bool) {
	var cerr *connect.Error
	if !errors.As(err, &cerr) {
		return nil, false
	}
	for _, d := range cerr.Details() {
		v, verr := d.Value()
		if verr != nil {
			continue
		}
		if ed, ok := v.(*tunnelv1.ErrorDetail); ok {
			return ed, true
		}
	}
	return nil, false
}
