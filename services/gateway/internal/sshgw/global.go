package sshgw

import "golang.org/x/crypto/ssh"

// forwardedGlobal are the client global requests passed on to the VM's
// sshd, with its reply and payload passed back (spec 9.4). Everything else
// is answered by the gateway.
var forwardedGlobal = map[string]bool{
	"tcpip-forward":                          true,
	"cancel-tcpip-forward":                   true,
	"streamlocal-forward@openssh.com":        true,
	"cancel-streamlocal-forward@openssh.com": true,
	"no-more-sessions@openssh.com":           true,
}

// clientGlobalRequests serves the client's global requests until the client
// conn closes. They are handled one at a time: replies to global requests
// must go out in request order.
//
//   - forwardedGlobal: sent to the backend, reply and payload passed back
//     (tcpip-forward with port 0 returns the bound port);
//   - keepalive@openssh.com, hostkeys-prove-00@openssh.com (the client sees
//     the gateway's host keys, not the VM's) and anything else: false.
func (ss *session) clientGlobalRequests(reqs <-chan *ssh.Request, backend ssh.Conn) {
	for r := range reqs {
		if !forwardedGlobal[r.Type] {
			if r.WantReply {
				_ = r.Reply(false, nil)
			}
			continue
		}
		ok, payload, err := backend.SendRequest(r.Type, r.WantReply, r.Payload)
		if err != nil {
			ok, payload = false, nil
		}
		if r.WantReply {
			_ = r.Reply(ok, payload)
		}
	}
}

// backendGlobalRequests serves the backend's global requests until the
// backend conn closes. None reach the client: hostkeys-00@openssh.com is
// dropped (it would show the client the VM's host keys), and
// keepalive@openssh.com and anything else are answered false.
func backendGlobalRequests(reqs <-chan *ssh.Request) {
	for r := range reqs {
		if r.WantReply {
			_ = r.Reply(false, nil)
		}
	}
}
