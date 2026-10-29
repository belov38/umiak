package errs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"syscall"
	"testing"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"
)

func TestFromErrno(t *testing.T) {
	tests := []struct {
		errno      syscall.Errno
		wantCode   connect.Code
		wantDetail string
	}{
		{syscall.ENOENT, connect.CodeNotFound, PathNotFound},
		{syscall.EEXIST, connect.CodeAlreadyExists, AlreadyExists},
		{syscall.ENOTDIR, connect.CodeFailedPrecondition, NotDirectory},
		{syscall.EISDIR, connect.CodeFailedPrecondition, IsDirectory},
		{syscall.ENOSPC, connect.CodeResourceExhausted, NoSpace},
		{syscall.EDQUOT, connect.CodeResourceExhausted, NoSpace},
		{syscall.EACCES, connect.CodePermissionDenied, PermissionDenied},
		{syscall.EXDEV, connect.CodeFailedPrecondition, CrossDevice},
		{syscall.EIO, connect.CodeInternal, Internal},
	}
	for _, tt := range tests {
		t.Run(tt.errno.Error(), func(t *testing.T) {
			// Wrapped in *fs.PathError like os.* returns it.
			err := FromErrno(&fs.PathError{Op: "open", Path: "/x", Err: tt.errno})
			if err.Code() != tt.wantCode {
				t.Errorf("code = %v, want %v", err.Code(), tt.wantCode)
			}
			d, ok := rpcconv.Detail(err)
			if !ok || d.GetCode() != tt.wantDetail {
				t.Errorf("detail = %v (ok=%v), want %q", d, ok, tt.wantDetail)
			}
		})
	}
}

func TestFromErrnoPassthrough(t *testing.T) {
	if FromErrno(nil) != nil {
		t.Error("FromErrno(nil) != nil")
	}
	orig := New(connect.CodeAborted, UpdateInProgress, "busy")
	if got := FromErrno(fmt.Errorf("wrap: %w", orig)); got != orig {
		t.Errorf("connect error not passed through: %v", got)
	}
}

func TestHTTPStatus(t *testing.T) {
	tests := []struct {
		code connect.Code
		want int
	}{
		{connect.CodeInvalidArgument, 400},
		{connect.CodeNotFound, 404},
		{connect.CodeAlreadyExists, 409},
		{connect.CodePermissionDenied, 403},
		{connect.CodeResourceExhausted, 429},
		{connect.CodeFailedPrecondition, 400},
		{connect.CodeAborted, 409},
		{connect.CodeUnavailable, 503},
		{connect.CodeInternal, 500},
		{connect.CodeUnimplemented, 501},
		{connect.CodeDeadlineExceeded, 504},
		{connect.CodeUnknown, 500},
	}
	for _, tt := range tests {
		if got := HTTPStatus(tt.code); got != tt.want {
			t.Errorf("HTTPStatus(%v) = %d, want %d", tt.code, got, tt.want)
		}
	}
}

type wantBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func TestWriteHTTP(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		want       wantBody
	}{
		{"path not found", New(connect.CodeNotFound, PathNotFound, "no such file"), http.StatusNotFound,
			wantBody{PathNotFound, "no such file", false}},
		{"wrapped", fmt.Errorf("x: %w", New(connect.CodeFailedPrecondition, IsDirectory, "is a dir")), http.StatusBadRequest,
			wantBody{IsDirectory, "is a dir", false}},
		{"payload too large", New(connect.CodeResourceExhausted, PayloadTooLarge, "too many entries"), http.StatusRequestEntityTooLarge,
			wantBody{PayloadTooLarge, "too many entries", false}},
		{"no space", New(connect.CodeResourceExhausted, NoSpace, "disk full"), http.StatusInsufficientStorage,
			wantBody{NoSpace, "disk full", false}},
		{"plain resource exhausted", New(connect.CodeResourceExhausted, TooManyCommands, "limit"), http.StatusTooManyRequests,
			wantBody{TooManyCommands, "limit", false}},
		{"retryable", New(connect.CodeUnavailable, Quiesced, "frozen"), http.StatusServiceUnavailable,
			wantBody{Quiesced, "frozen", true}},
		{"no detail", connect.NewError(connect.CodeNotFound, errors.New("nope")), http.StatusNotFound,
			wantBody{"not_found", "nope", false}},
		{"plain error", errors.New("boom"), http.StatusInternalServerError,
			wantBody{Internal, "internal error", false}},
		{"http error", HTTPError{Status: http.StatusUnprocessableEntity, Code: ChecksumMismatch, Message: "sha256 differs"}, http.StatusUnprocessableEntity,
			wantBody{ChecksumMismatch, "sha256 differs", false}},
		{"wrapped http error", fmt.Errorf("w: %w", HTTPError{Status: http.StatusConflict, Code: UploadOffsetMismatch, Message: "offset", Retryable: true}), http.StatusConflict,
			wantBody{UploadOffsetMismatch, "offset", true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			WriteHTTP(rec, tt.err)
			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q", ct)
			}
			var got wantBody
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("body = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestHTTPErrorImplementsError(t *testing.T) {
	var err error = HTTPError{Status: 422, Code: ChecksumMismatch, Message: "m"}
	if err.Error() == "" {
		t.Error("empty Error()")
	}
}

func TestWriteHTTPFields(t *testing.T) {
	rec := httptest.NewRecorder()
	err := New(connect.CodeInvalidArgument, InvalidPath, "bad entry")
	WriteHTTPFields(rec, err, map[string]any{"entries_written": 3, "code": "ignored"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	var got struct {
		wantBody
		EntriesWritten int `json:"entries_written"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.wantBody != (wantBody{InvalidPath, "bad entry", false}) || got.EntriesWritten != 3 {
		t.Fatalf("body = %s", rec.Body.Bytes())
	}
}
