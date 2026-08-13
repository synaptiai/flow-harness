package supervisor

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"
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

func TestWaitForKernelConnectionResolutionPreservesEarlyProcessExit(t *testing.T) {
	settlement := make(chan error, 1)
	want := errors.New("PRIVATE_EARLY_EXIT")
	settlement <- want
	reads := 0

	result := waitForKernelConnectionResolutionWith(
		context.Background(),
		settlement,
		func() ([]byte, error) {
			reads++
			return nil, errors.New("PRIVATE_UNRESOLVED")
		},
		make(chan time.Time),
		make(chan time.Time),
	)

	if !result.processSettled || result.processError != want || result.err != nil {
		t.Fatalf("early process exit changed: %#v", result)
	}
	if reads != 2 {
		t.Fatalf("early exit did not get one final resolution read: %d", reads)
	}
}

func TestWaitForKernelConnectionResolutionPrefersTheResolvedFile(t *testing.T) {
	settlement := make(chan error, 1)
	settlement <- errors.New("PRIVATE_EXIT")
	want := []byte("PRIVATE_RESOLVED")

	result := waitForKernelConnectionResolutionWith(
		context.Background(),
		settlement,
		func() ([]byte, error) { return want, nil },
		make(chan time.Time),
		make(chan time.Time),
	)

	if result.processSettled || result.err != nil || !bytes.Equal(result.resolved, want) {
		t.Fatalf("resolved connection changed: %#v", result)
	}
}

func TestWaitForKernelConnectionResolutionPollsUntilResolved(t *testing.T) {
	poll := make(chan time.Time, 1)
	poll <- time.Time{}
	reads := 0
	want := []byte("PRIVATE_RESOLVED")

	result := waitForKernelConnectionResolutionWith(
		context.Background(),
		make(chan error),
		func() ([]byte, error) {
			reads++
			if reads == 1 {
				return nil, errors.New("PRIVATE_UNRESOLVED")
			}
			return want, nil
		},
		poll,
		make(chan time.Time),
	)

	if result.processSettled || result.err != nil || !bytes.Equal(result.resolved, want) {
		t.Fatalf("polled connection changed: %#v", result)
	}
}

func TestWaitForKernelConnectionResolutionPreservesDeadlineAndCancellation(t *testing.T) {
	deadline := make(chan time.Time, 1)
	deadline <- time.Time{}
	result := waitForKernelConnectionResolutionWith(
		context.Background(),
		make(chan error),
		func() ([]byte, error) { return nil, errors.New("PRIVATE_UNRESOLVED") },
		make(chan time.Time),
		deadline,
	)
	if result.err == nil || result.err.Error() != "Python kernel connection did not resolve within its fixed deadline" {
		t.Fatalf("resolution deadline changed: %#v", result)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result = waitForKernelConnectionResolutionWith(
		ctx,
		make(chan error),
		func() ([]byte, error) { return nil, errors.New("PRIVATE_UNRESOLVED") },
		make(chan time.Time),
		make(chan time.Time),
	)
	if !errors.Is(result.err, context.Canceled) {
		t.Fatalf("resolution cancellation changed: %#v", result)
	}
}
