// Package winproc holds the Windows process primitives of the shim and the
// supervisor (spec 12.6): permanent named job objects, process start with an
// attribute list (job, inherited handles, pseudo console), ConPTY, CTRL_BREAK
// delivery and the shim liveness mutex. The package is empty on other
// platforms.
package winproc
