package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/dynamicpb"

	// The agent and tunnel APIs callable through `call`.
	_ "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	_ "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

const callUsage = "usage: umiak-agent call <package.Service/Method> [<json>|-]\n"

// callCmd implements `umiak-agent call <package.Service/Method> [<json>|-]`:
// one unary Connect call with a JSON body over the admin socket. The
// request is the JSON argument, stdin for "-", or {} without one. The
// response is printed as JSON with proto field names; a refused call exits
// 1 with the Connect error JSON on stderr. Every call carries a new
// Umiak-Request-Id.
func callCmd(ctx context.Context, d deps, args []string, stdout, stderr io.Writer) int {
	if len(args) < 1 || len(args) > 2 {
		_, _ = io.WriteString(stderr, callUsage)
		return exitUsage
	}
	sock := adminSocket(d, "call", stderr)
	if sock == "" {
		return exitUsage
	}
	md, err := findMethod(args[0])
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent call: %v\n", err)
		return exitUsage
	}
	body := []byte("{}")
	if len(args) == 2 {
		body = []byte(args[1])
		if args[1] == "-" {
			if body, err = io.ReadAll(d.stdin); err != nil {
				_, _ = fmt.Fprintf(stderr, "umiak-agent call: read stdin: %v\n", err)
				return 1
			}
			// Windows PowerShell 5.1 writes UTF-8 with a BOM, and with
			// $OutputEncoding set to UTF-8 a pipe can carry two.
			for bytes.HasPrefix(body, []byte{0xef, 0xbb, 0xbf}) {
				body = body[3:]
			}
		}
	}
	in := dynamicpb.NewMessage(md.Input())
	if err := protojson.Unmarshal(body, in); err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent call: request: %v\n", err)
		return exitUsage
	}
	reqBody, err := protojson.Marshal(in)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent call: request: %v\n", err)
		return 1
	}
	url := agentURL + "/" + string(md.Parent().FullName()) + "/" + string(md.Name())
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent call: %v\n", err)
		return 1
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set(wire.HeaderRequestID, uuid.NewString())
	res, err := socketClient(sock).Do(req)
	if err != nil {
		if unreachable(err) {
			_, _ = fmt.Fprintf(stderr, "umiak-agent call: the agent is not reachable on %s: %v\n", sock, err)
		} else {
			_, _ = fmt.Fprintf(stderr, "umiak-agent call: %v\n", err)
		}
		return 1
	}
	defer func() { _ = res.Body.Close() }()
	resBody, err := io.ReadAll(res.Body)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent call: read response: %v\n", err)
		return 1
	}
	if res.StatusCode != http.StatusOK {
		if len(bytes.TrimSpace(resBody)) == 0 {
			resBody = fmt.Appendf(nil, `{"code":"unknown","message":%q}`, res.Status)
		}
		_, _ = stderr.Write(append(bytes.TrimSpace(resBody), '\n'))
		return 1
	}
	out := dynamicpb.NewMessage(md.Output())
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(resBody, out); err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent call: response: %v\n", err)
		return 1
	}
	compact, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(out)
	var pretty bytes.Buffer
	if err == nil {
		// protojson varies its whitespace on purpose; json.Indent makes
		// the output stable.
		err = json.Indent(&pretty, compact, "", "  ")
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent call: response: %v\n", err)
		return 1
	}
	pretty.WriteByte('\n')
	_, _ = stdout.Write(pretty.Bytes())
	return 0
}

// findMethod resolves "package.Service/Method" (a leading "/" is allowed)
// to a unary method of a registered service.
func findMethod(name string) (protoreflect.MethodDescriptor, error) {
	svc, method, ok := strings.Cut(strings.TrimPrefix(name, "/"), "/")
	if !ok || svc == "" || method == "" {
		return nil, fmt.Errorf("%q: want package.Service/Method", name)
	}
	desc, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(svc))
	if err != nil {
		return nil, fmt.Errorf("unknown service %s", svc)
	}
	sd, ok := desc.(protoreflect.ServiceDescriptor)
	if !ok {
		return nil, fmt.Errorf("%s is not a service", svc)
	}
	md := sd.Methods().ByName(protoreflect.Name(method))
	if md == nil {
		return nil, fmt.Errorf("unknown method %s/%s", svc, method)
	}
	if md.IsStreamingClient() || md.IsStreamingServer() {
		return nil, fmt.Errorf("%s/%s is a streaming method; call takes unary methods only", svc, method)
	}
	return md, nil
}
