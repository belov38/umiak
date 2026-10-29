// Package e2e holds the multi-gateway scenario tests of the tunnel library
// (S2 spec sections 1, 7, 9.1, 14.1-14.2 scaled down): gateways on one
// in-memory network and one database, agents serving the Process test
// double, and Connect clients going through the gateways' internal
// listeners. It has no non-test code.
package e2e
