package edge

import "time"

// SetPollInterval changes the mtime poll interval of c; call before Run.
func (c *CertSource) SetPollInterval(d time.Duration) { c.pollEvery = d }
