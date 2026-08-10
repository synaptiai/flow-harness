//go:build !linux

package supervisor

import (
	"net"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
)

func PeerUID(_ *net.UnixConn) (int, error) {
	return 0, &unsupportedPlatformError{}
}

func RunKernel(_ kernelcontract.Request) (int, string) {
	return 125, "Prime kernel supervision requires Linux"
}

type unsupportedPlatformError struct{}

func (*unsupportedPlatformError) Error() string {
	return "Prime kernel supervision requires Linux"
}
