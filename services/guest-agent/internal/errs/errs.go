// Package errs maps agent failures to Connect errors with an ErrorDetail and
// to HTTP responses for the /files endpoints (spec sections 11.1 and 19).
package errs

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"syscall"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"
)

// ErrorDetail codes of the agent (spec section 19 plus executor additions).
const (
	AlreadyExists        = "already_exists"
	CommandNotFound      = "command_not_found"
	CommandExited        = "command_exited"
	TooManyCommands      = "too_many_commands"
	StartFailed          = "start_failed"
	UserNotFound         = "user_not_found"
	PathNotFound         = "path_not_found"
	IsDirectory          = "is_directory"
	NotDirectory         = "not_directory"
	NoSpace              = "no_space"
	CrossDevice          = "cross_device"
	UploadOffsetMismatch = "upload_offset_mismatch"
	ChecksumMismatch     = "checksum_mismatch"
	IdentityNotReady     = "identity_not_ready"
	AlreadyClaimed       = "already_claimed"
	NotClaimed           = "not_claimed"
	Quiesced             = "quiesced"
	AlreadyQuiesced      = "already_quiesced"
	FrozenByOther        = "frozen_by_other"
	SignatureInvalid     = "signature_invalid"
	UpdateInProgress     = "update_in_progress"
	ShimOutdated         = "shim_outdated"
	RequestIDReused      = "request_id_reused"

	InvalidPath     = "invalid_path"
	PayloadTooLarge = "payload_too_large"
	UploadNotFound  = "upload_not_found"
	BadVersion      = "bad_version"

	// PermissionDenied and Internal have no entry in the spec list; they keep
	// the JSON body of /files uniform.
	PermissionDenied = "permission_denied"
	Internal         = "internal"
)

// New builds a Connect error with an ErrorDetail.
func New(code connect.Code, detailCode, msg string) *connect.Error {
	return rpcconv.NewError(code, detailCode, msg)
}

// Newf is New with a formatted message.
func Newf(code connect.Code, detailCode, format string, args ...any) *connect.Error {
	return New(code, detailCode, fmt.Sprintf(format, args...))
}

// FromErrno maps a filesystem error to a Connect error (spec section 11.1).
// A *connect.Error anywhere in the chain is returned as is; nil maps to nil.
// Unknown errors become internal.
func FromErrno(err error) *connect.Error {
	if err == nil {
		return nil
	}
	var cerr *connect.Error
	if errors.As(err, &cerr) {
		return cerr
	}
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return New(connect.CodeInternal, Internal, err.Error())
	}
	msg := err.Error()
	switch errno {
	case syscall.ENOENT:
		return New(connect.CodeNotFound, PathNotFound, msg)
	case syscall.EEXIST:
		return New(connect.CodeAlreadyExists, AlreadyExists, msg)
	case syscall.ENOTDIR:
		return New(connect.CodeFailedPrecondition, NotDirectory, msg)
	case syscall.EISDIR:
		return New(connect.CodeFailedPrecondition, IsDirectory, msg)
	case syscall.ENOSPC, syscall.EDQUOT:
		return New(connect.CodeResourceExhausted, NoSpace, msg)
	case syscall.EACCES, syscall.EPERM:
		return New(connect.CodePermissionDenied, PermissionDenied, msg)
	case syscall.EXDEV:
		return New(connect.CodeFailedPrecondition, CrossDevice, msg)
	default:
		return New(connect.CodeInternal, Internal, msg)
	}
}

// HTTPStatus maps a Connect code to an HTTP status like the Connect protocol.
// WriteHTTP refines ResourceExhausted by detail code.
func HTTPStatus(code connect.Code) int {
	switch code {
	case connect.CodeInvalidArgument, connect.CodeFailedPrecondition, connect.CodeOutOfRange:
		return http.StatusBadRequest
	case connect.CodeUnauthenticated:
		return http.StatusUnauthorized
	case connect.CodePermissionDenied:
		return http.StatusForbidden
	case connect.CodeNotFound:
		return http.StatusNotFound
	case connect.CodeAlreadyExists, connect.CodeAborted:
		return http.StatusConflict
	case connect.CodeResourceExhausted:
		return http.StatusTooManyRequests
	case connect.CodeCanceled:
		return 499
	case connect.CodeUnimplemented:
		return http.StatusNotImplemented
	case connect.CodeUnavailable:
		return http.StatusServiceUnavailable
	case connect.CodeDeadlineExceeded:
		return http.StatusGatewayTimeout
	default:
		return http.StatusInternalServerError
	}
}

// HTTPError is an error with an explicit HTTP status, for responses that have
// no Connect equivalent (409 offset mismatch, 422 checksum mismatch).
type HTTPError struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
}

// Error implements error.
func (e HTTPError) Error() string {
	return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message)
}

// httpBody is the JSON body of an error response.
type httpBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// WriteHTTP writes err as an HTTP JSON error {code, message, retryable}. An
// HTTPError is written as is; a *connect.Error is mapped with HTTPStatus and
// its ErrorDetail code (fallback: the Connect code string); any other error
// becomes 500 internal without leaking its text.
func WriteHTTP(w http.ResponseWriter, err error) {
	var herr HTTPError
	var cerr *connect.Error
	var status int
	var body httpBody
	switch {
	case errors.As(err, &herr):
		status = herr.Status
		body = httpBody{herr.Code, herr.Message, herr.Retryable}
	case errors.As(err, &cerr):
		status = HTTPStatus(cerr.Code())
		body = httpBody{cerr.Code().String(), cerr.Message(), rpcconv.Retryable(cerr.Code())}
		if d, ok := rpcconv.Detail(cerr); ok {
			body.Code, body.Retryable = d.GetCode(), d.GetRetryable()
			if cerr.Code() == connect.CodeResourceExhausted {
				switch d.GetCode() {
				case PayloadTooLarge:
					status = http.StatusRequestEntityTooLarge
				case NoSpace:
					status = http.StatusInsufficientStorage
				}
			}
		}
	default:
		status = http.StatusInternalServerError
		body = httpBody{Code: Internal, Message: "internal error"}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
