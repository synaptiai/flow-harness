package supervisor

import (
	"context"
	"errors"
	"time"
)

type kernelConnectionResolutionResult struct {
	resolved       []byte
	processError   error
	processSettled bool
	err            error
}

func waitForKernelSettlement(
	ctx context.Context,
	settlement <-chan error,
	killProcessGroup func() error,
) (error, bool) {
	select {
	case err := <-settlement:
		return err, false
	case <-ctx.Done():
		_ = killProcessGroup()
		return <-settlement, true
	}
}

func waitForKernelConnectionResolutionWith(
	ctx context.Context,
	settlement <-chan error,
	readResolved func() ([]byte, error),
	poll <-chan time.Time,
	deadline <-chan time.Time,
) kernelConnectionResolutionResult {
	if resolved, err := readResolved(); err == nil {
		return kernelConnectionResolutionResult{resolved: resolved}
	}
	for {
		select {
		case processError := <-settlement:
			if resolved, err := readResolved(); err == nil {
				return kernelConnectionResolutionResult{resolved: resolved}
			}
			return kernelConnectionResolutionResult{
				processError:   processError,
				processSettled: true,
			}
		case <-ctx.Done():
			return kernelConnectionResolutionResult{err: ctx.Err()}
		case <-deadline:
			return kernelConnectionResolutionResult{
				err: errors.New("Python kernel connection did not resolve within its fixed deadline"),
			}
		case <-poll:
			if resolved, err := readResolved(); err == nil {
				return kernelConnectionResolutionResult{resolved: resolved}
			}
		}
	}
}
