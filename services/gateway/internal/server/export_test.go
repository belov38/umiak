package server

import "net/http"

// MetricsServer exposes the metrics listener's server to the tests.
func (i *Instance) MetricsServer() *http.Server { return i.metricsSrv }
