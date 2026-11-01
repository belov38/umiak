// Package errs maps agent failures to Connect errors with an ErrorDetail and
// to HTTP responses for the /files endpoints (spec sections 11.1 and 19).
package errs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"syscall"

	"connectrpc.com/connect"

	"github.com/belov38/umiak/libs/tunnel/rpcconv"
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

	// CommandRunning refuses Process.Remove of a command that is still
	// running (or has live leftovers).
	CommandRunning = "command_running"
	// ShimUnavailable: the shim of a running command cannot be reached at
	// the moment. It is always sent with connect.CodeUnavailable, so the
	// detail is retryable and the caller retries the call.
	ShimUnavailable = "shim_unavailable"
	// InvalidArgument and FailedPrecondition are the generic details of
	// requests that no specific code describes.
	InvalidArgument    = "invalid_argument"
	FailedPrecondition = "failed_precondition"
	// Unimplemented: the agent build does not wire the feature (for
	// example quiesce or update before they are installed).
	Unimplemented = "unimplemented"
	// LeaseExpired (aborted): a Quiesce reached its own lease deadline, or
	// the watchdog unit thawed the lease, before all steps were done; the
	// lease was rolled back.
	LeaseExpired = "lease_expired"
	// QuiesceTimeout (deadline_exceeded, retryable): the freeze steps of a
	// Quiesce took longer than the 5 s budget; the lease was rolled back.
	QuiesceTimeout = "quiesce_timeout"
	// StoreBusy (unavailable, retryable): the state store did not stop
	// writing in time for a freeze, probably because a commit hangs on a
	// filesystem frozen by someone else.
	StoreBusy = "store_busy"

	// UnsupportedSignal (invalid_argument): the platform cannot deliver the
	// requested signal to a command (Windows).
	UnsupportedSignal = "unsupported_signal"
	// UnsafeBatchArgs (invalid_argument): an argv for a .cmd or .bat file
	// cannot be passed to cmd.exe without changing its meaning.
	UnsafeBatchArgs = "unsafe_batch_args"
	// FileInUse (failed_precondition): the file is held open by another
	// process and cannot be replaced or deleted (Windows).
	FileInUse = "file_in_use"
	// SecretsInUse (failed_precondition): a secret file is held open, so
	// Quiesce with wipe_secret_files rolled back.
	SecretsInUse = "secrets_in_use"
	// SecretsPending: the secrets were not sent again after an agent
	// restart. Process/Start answers unavailable (retryable) after waiting
	// for them (S9 spec 12.8); failed_precondition when the secret files
	// are not restored yet after a restart during a lease.
	SecretsPending = "secrets_pending"
	// FsFreezeUnsupported (failed_precondition): Quiesce with fs=true on a
	// platform without a filesystem freeze (Windows).
	FsFreezeUnsupported = "fs_freeze_unsupported"
	// DesktopNotReady (failed_precondition): CommandSpec.desktop is set but
	// the agent has no interactive desktop session.
	DesktopNotReady = "desktop_not_ready"

	// PermissionDenied and Internal have no entry in the spec list; they keep
	// the JSON body of /files uniform.
	PermissionDenied = "permission_denied"
	Internal         = "internal"
)

// ErrSecretInUse reports a secret file held open by another process without
// sharing write and delete access, so it cannot be wiped (Windows). The
// claim manager returns it; quiesce maps it to secrets_in_use.
var ErrSecretInUse = errors.New("secret file is in use")

// New builds a Connect error with an ErrorDetail.
func New(code connect.Code, detailCode, msg string) *connect.Error {
	return rpcconv.NewError(code, detailCode, msg)
}

// Newf is New with a formatted message.
func Newf(code connect.Code, detailCode, format string, args ...any) *connect.Error {
	return New(code, detailCode, fmt.Sprintf(format, args...))
}

// NewRetryable is New with ErrorDetail.retryable set regardless of the code,
// for conditions the caller may retry that are not unavailable (such as
// failed_precondition file_in_use).
func NewRetryable(code connect.Code, detailCode, msg string) *connect.Error {
	return rpcconv.NewRetryableError(code, detailCode, msg)
}

// mapping is the Connect error an errno maps to.
type mapping struct {
	code      connect.Code
	detail    string
	retryable bool
}

var (
	notDirectory = mapping{code: connect.CodeFailedPrecondition, detail: NotDirectory}
	noSpace      = mapping{code: connect.CodeResourceExhausted, detail: NoSpace}
	crossDevice  = mapping{code: connect.CodeFailedPrecondition, detail: CrossDevice}
	notEmpty     = mapping{code: connect.CodeFailedPrecondition, detail: FailedPrecondition}
)

// errnoTable maps the errnos that the fs sentinels do not cover (and a
// non-empty directory, which they cover as fs.ErrExist). The constants exist
// on every OS: on Windows package syscall invents them and portable agent
// code returns them. errs_windows.go adds the Win32 codes.
var errnoTable = map[syscall.Errno]mapping{
	syscall.ENOTEMPTY: notEmpty,
	syscall.ENOTDIR:   notDirectory,
	syscall.EISDIR:    {code: connect.CodeFailedPrecondition, detail: IsDirectory},
	syscall.ENOSPC:    noSpace,
	syscall.EDQUOT:    noSpace,
	syscall.EXDEV:     crossDevice,
}

// lookupErrno returns the table entry of the first errno in err's chain.
// osErrnoTable comes first: on Windows some invented errnos of package
// syscall are real Win32 codes (syscall.ENOTDIR is ERROR_PATH_NOT_FOUND).
func lookupErrno(err error) (mapping, bool) {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return mapping{}, false
	}
	if m, ok := osErrnoTable[errno]; ok {
		return m, true
	}
	m, ok := errnoTable[errno]
	return m, ok
}

// FromErrno maps a filesystem error to a Connect error (spec section 11.1,
// S9 spec section 12.9 for Windows). A *connect.Error anywhere in the chain
// is returned as is; nil maps to nil. The first errno in the chain maps by
// errnoTable and osErrnoTable; otherwise not-found, already-exists and
// permission errors map by fs.ErrNotExist, fs.ErrExist and fs.ErrPermission,
// which also cover their Win32 codes. The tables come first so that a
// non-empty directory, which fs.ErrExist also matches, is failed_precondition;
// the other entries do not overlap the sentinels. Unknown errors become
// internal.
func FromErrno(err error) *connect.Error {
	if err == nil {
		return nil
	}
	var cerr *connect.Error
	if errors.As(err, &cerr) {
		return cerr
	}
	msg := err.Error()
	m, ok := lookupErrno(err)
	if !ok {
		switch {
		case errors.Is(err, fs.ErrNotExist):
			m, ok = mapping{code: connect.CodeNotFound, detail: PathNotFound}, true
		case errors.Is(err, fs.ErrExist):
			m, ok = mapping{code: connect.CodeAlreadyExists, detail: AlreadyExists}, true
		case errors.Is(err, fs.ErrPermission):
			m, ok = mapping{code: connect.CodePermissionDenied, detail: PermissionDenied}, true
		}
	}
	switch {
	case !ok:
		return New(connect.CodeInternal, Internal, msg)
	case m.retryable:
		return NewRetryable(m.code, m.detail, msg)
	default:
		return New(m.code, m.detail, msg)
	}
}

// IsNoSpace reports whether err is a full disk or an exceeded quota (ENOSPC,
// EDQUOT or, on Windows, ERROR_DISK_FULL and its relatives anywhere in the
// chain).
func IsNoSpace(err error) bool {
	for _, t := range []map[syscall.Errno]mapping{errnoTable, osErrnoTable} {
		for errno, m := range t {
			if m == noSpace && errors.Is(err, errno) {
				return true
			}
		}
	}
	return false
}

// Wrap maps a local failure of the step what: a *connect.Error in the chain
// is returned as is, a full disk becomes resource_exhausted/no_space and
// anything else internal. The message is "what: err".
func Wrap(what string, err error) *connect.Error {
	var cerr *connect.Error
	if errors.As(err, &cerr) {
		return cerr
	}
	if IsNoSpace(err) {
		return Newf(connect.CodeResourceExhausted, NoSpace, "%s: %v", what, err)
	}
	return Newf(connect.CodeInternal, Internal, "%s: %v", what, err)
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
	WriteHTTPFields(w, err, nil)
}

// WriteHTTPFields is WriteHTTP with extra top-level fields in the JSON body
// (for example entries_written of an archive upload). Fields never replace
// code, message or retryable.
func WriteHTTPFields(w http.ResponseWriter, err error, fields map[string]any) {
	status, body := httpResponse(err)
	out := make(map[string]any, len(fields)+3)
	for k, v := range fields {
		out[k] = v
	}
	out["code"], out["message"], out["retryable"] = body.Code, body.Message, body.Retryable
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(out)
}

// httpResponse maps err to an HTTP status and error body.
func httpResponse(err error) (int, httpBody) {
	var herr HTTPError
	var cerr *connect.Error
	switch {
	case errors.As(err, &herr):
		return herr.Status, httpBody{herr.Code, herr.Message, herr.Retryable}
	case errors.As(err, &cerr):
		status := HTTPStatus(cerr.Code())
		body := httpBody{cerr.Code().String(), cerr.Message(), rpcconv.Retryable(cerr.Code())}
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
		return status, body
	default:
		return http.StatusInternalServerError, httpBody{Code: Internal, Message: "internal error"}
	}
}
