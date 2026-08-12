package supervisor

import "context"

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
