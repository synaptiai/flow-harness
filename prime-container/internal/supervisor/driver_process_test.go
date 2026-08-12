package supervisor

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/synaptiai/flow-harness/prime-container/internal/containerprotocol"
)

const processTestHello = `{"version":1,"sequence":1,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"hello","payload":{"secretHex":"1111111111111111111111111111111111111111111111111111111111111111","trialId":"trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"mac":"47b869ad338a1066ed892cd559e6dd3376fd2a32084409d3d45b512ba406e93c"}`
const processTestReady = `{"version":1,"sequence":1,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"ready","payload":{"trialId":"trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"mac":"d69b44e493b862e87787adc750fdefa7d11666002d3517ff66db3dc7fc9166f6"}`
const processTestTerminal = `{"version":1,"sequence":2,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"terminal","payload":{"harness":{"outcome":"completed","runId":"prime-test","reason":null},"metrics":{"costUsdMicros":null,"inputTokens":null,"cacheReadTokens":null,"cacheWriteTokens":null,"outputTokens":null,"turns":0,"toolCalls":0,"toolErrors":0,"wallTimeMs":0,"activeTimeMs":null,"interventions":null,"policyViolations":null,"recoveryAttempts":0,"recoveryOutcome":"not_attempted"}},"mac":"76895bab04b53254704d7a3d28dd4b95fb18c57f4d4cc33aa33fb41424ea0708"}`

func TestRunDriverProcessUsesPrivateProtocolAndHardeningDescriptors(t *testing.T) {
	var output bytes.Buffer
	result, err := RunDriverProcess(
		&bytes.Buffer{},
		&output,
		[]byte(processTestHello),
		DriverProcessOptions{
			Executable:       os.Args[0],
			Arguments:        []string{"-test.run=TestPrimeDriverHelperProcess", "--"},
			Environment:      append(os.Environ(), "FLOW_PRIME_TEST_DRIVER=1", "FLOW_PRIME_TEST_HARDENING=1"),
			WorkingDirectory: t.TempDir(),
			UID:              -1, GID: -1,
			MaxDiagnosticBytes: 65536,
		},
	)
	if err != nil {
		t.Fatalf("run driver process: %v", err)
	}
	if result.ExitCode != 0 || result.Diagnostic != "" {
		t.Fatalf("driver result changed: %#v", result)
	}
	for index, expected := range []containerprotocol.FrameType{
		containerprotocol.FrameDriver,
		containerprotocol.FrameDriver,
		containerprotocol.FrameTerminal,
	} {
		frame, err := containerprotocol.ReadFrame(&output)
		if err != nil || frame.Type != expected {
			t.Fatalf("driver output frame %d changed: %#v %v", index, frame, err)
		}
	}
	if output.Len() != 0 {
		t.Fatalf("driver output has %d trailing bytes", output.Len())
	}
}

func TestRunDriverProcessRejectsMissingHardeningProof(t *testing.T) {
	var output bytes.Buffer
	_, err := RunDriverProcess(
		&bytes.Buffer{},
		&output,
		[]byte(processTestHello),
		DriverProcessOptions{
			Executable:       os.Args[0],
			Arguments:        []string{"-test.run=TestPrimeDriverHelperProcess", "--"},
			Environment:      append(os.Environ(), "FLOW_PRIME_TEST_DRIVER=1"),
			WorkingDirectory: t.TempDir(),
			UID:              -1, GID: -1,
			MaxDiagnosticBytes: 65536,
		},
	)
	if err == nil || !strings.Contains(err.Error(), "hardening proof") {
		t.Fatalf("missing hardening proof was not rejected: %v", err)
	}
}

func TestRunDriverProcessTerminatesDiagnosticOverflow(t *testing.T) {
	started := time.Now()
	_, err := RunDriverProcess(
		&bytes.Buffer{},
		&bytes.Buffer{},
		[]byte(processTestHello),
		DriverProcessOptions{
			Executable: os.Args[0],
			Arguments:  []string{"-test.run=TestPrimeDriverHelperProcess", "--"},
			Environment: append(
				os.Environ(),
				"FLOW_PRIME_TEST_DRIVER=1",
				"FLOW_PRIME_TEST_HARDENING=1",
				"FLOW_PRIME_TEST_DIAGNOSTIC_OVERFLOW=1",
			),
			WorkingDirectory: t.TempDir(),
			UID:              -1, GID: -1,
			MaxDiagnosticBytes: 1024,
		},
	)
	if err == nil || !strings.Contains(err.Error(), "diagnostic exceeds") {
		t.Fatalf("diagnostic overflow was not rejected: %v", err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("diagnostic overflow did not settle within five seconds")
	}
}

func TestRunDriverProcessPromotesOnlyClosedDriverStages(t *testing.T) {
	var output bytes.Buffer
	result, err := RunDriverProcess(
		&bytes.Buffer{},
		&output,
		[]byte(processTestHello),
		DriverProcessOptions{
			Executable: os.Args[0],
			Arguments:  []string{"-test.run=TestPrimeDriverHelperProcess", "--"},
			Environment: append(
				os.Environ(),
				"FLOW_PRIME_TEST_DRIVER=1",
				"FLOW_PRIME_TEST_HARDENING=1",
				"FLOW_PRIME_TEST_STAGE_DIAGNOSTIC=create-sdk-session",
			),
			WorkingDirectory: t.TempDir(),
			UID:              -1, GID: -1,
			MaxDiagnosticBytes: 65536,
		},
	)
	if err == nil || err.Error() != "Prime driver stage failure: create-sdk-session" {
		t.Fatalf("closed driver stage was not promoted: %v", err)
	}
	if result.Diagnostic != "Prime driver stage failure: create-sdk-session\n" {
		t.Fatalf("driver diagnostic changed: %q", result.Diagnostic)
	}
}

func TestRunDriverProcessAllowsClosedStageToSettleAfterDriverEOF(t *testing.T) {
	result, err := RunDriverProcess(
		&bytes.Buffer{},
		&bytes.Buffer{},
		[]byte(processTestHello),
		DriverProcessOptions{
			Executable: os.Args[0],
			Arguments:  []string{"-test.run=TestPrimeDriverHelperProcess", "--"},
			Environment: append(
				os.Environ(),
				"FLOW_PRIME_TEST_DRIVER=1",
				"FLOW_PRIME_TEST_HARDENING=1",
				"FLOW_PRIME_TEST_DELAYED_STAGE_DIAGNOSTIC=load-sdk",
			),
			WorkingDirectory: t.TempDir(),
			UID:              -1, GID: -1,
			MaxDiagnosticBytes: 65536,
		},
	)
	if err == nil || err.Error() != "Prime driver stage failure: load-sdk" {
		t.Fatalf("delayed closed driver stage was not promoted: %v", err)
	}
	if result.Diagnostic != "Prime driver stage failure: load-sdk\n" {
		t.Fatalf("delayed driver diagnostic changed: %q", result.Diagnostic)
	}
}

func TestSettleDriverProcessAfterRelayFailureUsesOneGraceDeadline(t *testing.T) {
	expected := errors.New("PRIVATE_WAIT_ERROR")
	t.Run("settled child", func(t *testing.T) {
		settled := make(chan error, 1)
		settled <- expected
		killed := false
		waitError := settleDriverProcessAfterRelayFailure(
			settled,
			make(chan time.Time),
			func() error {
				killed = true
				return nil
			},
		)
		if !errors.Is(waitError, expected) || killed {
			t.Fatalf("settled child was killed: %v %t", waitError, killed)
		}
	})
	t.Run("grace deadline", func(t *testing.T) {
		settled := make(chan error, 1)
		deadline := make(chan time.Time, 1)
		deadline <- time.Now()
		kills := 0
		waitError := settleDriverProcessAfterRelayFailure(
			settled,
			deadline,
			func() error {
				kills++
				settled <- expected
				return nil
			},
		)
		if !errors.Is(waitError, expected) || kills != 1 {
			t.Fatalf("unsettled child was not killed once: %v %d", waitError, kills)
		}
	})
}

func TestPrimeDriverHelperProcess(t *testing.T) {
	if os.Getenv("FLOW_PRIME_TEST_DRIVER") != "1" {
		return
	}
	if os.Getenv("FLOW_PRIME_TEST_HARDENING") == "1" {
		hardening := os.NewFile(4, "flow-prime-test-hardening")
		if hardening == nil {
			os.Exit(120)
		}
		if _, err := hardening.Write([]byte{1}); err != nil {
			os.Exit(120)
		}
		if err := hardening.Close(); err != nil {
			os.Exit(120)
		}
	} else {
		hardening := os.NewFile(4, "flow-prime-test-hardening")
		if hardening == nil || hardening.Close() != nil {
			os.Exit(120)
		}
	}
	if os.Getenv("FLOW_PRIME_TEST_DIAGNOSTIC_OVERFLOW") == "1" {
		for {
			if _, err := os.Stderr.Write(bytes.Repeat([]byte("x"), 65536)); err != nil {
				os.Exit(0)
			}
		}
	}
	if stage := os.Getenv("FLOW_PRIME_TEST_STAGE_DIAGNOSTIC"); stage != "" {
		fmt.Fprintf(os.Stderr, "Prime driver stage failure: %s\n", stage)
		_ = os.NewFile(3, "flow-prime-test-driver").Close()
		os.Exit(125)
	}
	if stage := os.Getenv("FLOW_PRIME_TEST_DELAYED_STAGE_DIAGNOSTIC"); stage != "" {
		_ = os.NewFile(3, "flow-prime-test-driver").Close()
		time.Sleep(500 * time.Millisecond)
		fmt.Fprintf(os.Stderr, "Prime driver stage failure: %s\n", stage)
		os.Exit(125)
	}
	socket := os.NewFile(3, "flow-prime-test-driver")
	if socket == nil {
		os.Exit(121)
	}
	reader := bufio.NewReader(socket)
	line, err := reader.ReadString('\n')
	if err != nil || line != processTestHello+"\n" {
		fmt.Fprintln(os.Stderr, "test driver bootstrap changed")
		os.Exit(122)
	}
	for _, frame := range []string{processTestReady, processTestTerminal} {
		if _, err := socket.Write([]byte(frame + "\n")); err != nil {
			fmt.Fprintln(os.Stderr, "test driver write failed")
			os.Exit(123)
		}
	}
	if err := socket.Close(); err != nil {
		os.Exit(124)
	}
	os.Exit(0)
}
