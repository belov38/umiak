package sshgw

// InteractiveChannels returns the number of open interactive session
// channels on srv.
func InteractiveChannels(srv *Server) int {
	n := 0
	for _, ss := range srv.snapshot() {
		n += len(ss.sessionChannels(true))
	}
	return n
}

// NotifyInteractive writes msg to the stderr of every interactive session
// channel on srv and waits for the writes.
func NotifyInteractive(srv *Server, msg string) {
	for _, ss := range srv.snapshot() {
		<-ss.notify(msg, true)
	}
}
