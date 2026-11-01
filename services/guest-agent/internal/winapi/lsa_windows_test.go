package winapi

import (
	"bytes"
	"errors"
	"os"
	"slices"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Needs SYSTEM or an administrator (LSA private data).
func TestLsaStoreRetrieveDelete(t *testing.T) {
	name := "L$umiak_test_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	data := []byte("pa55-wörd\x00tail")
	if err := LsaStore(name, data); err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			t.Skip("not privileged:", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = LsaStore(name, nil) })
	got, err := LsaRetrieve(name)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("LsaRetrieve = %q, %v", got, err)
	}
	if err := LsaStore(name, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := LsaRetrieve(name); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted secret: %v", err)
	}
	// Deleting again is fine.
	if err := LsaStore(name, nil); err != nil {
		t.Fatal(err)
	}
}

func TestLogonUserTokenUnknownUser(t *testing.T) {
	if _, err := LogonUserToken("umiak-no-such-user", []byte("x")); err == nil {
		t.Fatal("logon of an unknown user succeeded")
	}
}

func TestUTF16Secret(t *testing.T) {
	got, err := utf16Secret([]byte("aé🙂"))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := windows.UTF16FromString("aé🙂")
	if !slices.Equal(got, want) || cap(got) != len("aé🙂")+1 {
		t.Fatalf("utf16Secret = %v (cap %d), want %v", got, cap(got), want)
	}
	if _, err := utf16Secret([]byte("a\x00b")); err == nil {
		t.Fatal("NUL accepted")
	}
}
