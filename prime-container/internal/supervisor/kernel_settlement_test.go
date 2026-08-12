package supervisor

import (
	"context"
	"errors"
	"testing"
)

func TestWaitForKernelSettlementKillsAndReapsAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	settlement := make(chan error, 1)
	killed := make(chan struct{}, 1)
	want := errors.New("PRIVATE_KERNEL_SETTLEMENT")
	cancel()

	got, cancelled := waitForKernelSettlement(ctx, settlement, func() error {
		killed <- struct{}{}
		settlement <- want
		return nil
	})

	if !cancelled {
		t.Fatal("kernel cancellation was not reported")
	}
	if got != want {
		t.Fatalf("kernel settlement identity changed: %v", got)
	}
	select {
	case <-killed:
	default:
		t.Fatal("kernel process was not killed")
	}
}

func TestWaitForKernelSettlementPreservesNaturalExit(t *testing.T) {
	settlement := make(chan error, 1)
	want := errors.New("PRIVATE_NATURAL_SETTLEMENT")
	settlement <- want

	got, cancelled := waitForKernelSettlement(
		context.Background(),
		settlement,
		func() error {
			t.Fatal("naturally settled kernel was killed")
			return nil
		},
	)

	if cancelled {
		t.Fatal("natural kernel settlement was reported as cancellation")
	}
	if got != want {
		t.Fatalf("natural settlement identity changed: %v", got)
	}
}
