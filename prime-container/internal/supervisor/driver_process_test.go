package supervisor

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/synaptiai/flow-harness/prime-container/internal/containerprotocol"
)

const processTestHello = `{"version":1,"sequence":1,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"hello","payload":{"secretHex":"1111111111111111111111111111111111111111111111111111111111111111","trialId":"trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"mac":"47b869ad338a1066ed892cd559e6dd3376fd2a32084409d3d45b512ba406e93c"}`
const processTestReady = `{"version":1,"sequence":1,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"ready","payload":{"trialId":"trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"mac":"d69b44e493b862e87787adc750fdefa7d11666002d3517ff66db3dc7fc9166f6"}`
const processTestRequest = `{"version":1,"sequence":2,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"inference_request","payload":{"requestId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e935","body":"{}","bodySha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"},"mac":"8f38868437b773127867237e0422a04973bad8bada371d3b847fd1fbf4eaf9e8"}`
const processTestTerminal = `{"version":1,"sequence":2,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"terminal","payload":{"harness":{"outcome":"completed","runId":"prime-test","reason":null},"metrics":{"costUsdMicros":null,"inputTokens":null,"cacheReadTokens":null,"cacheWriteTokens":null,"outputTokens":null,"turns":0,"toolCalls":0,"toolErrors":0,"wallTimeMs":0,"activeTimeMs":null,"interventions":null,"policyViolations":null,"recoveryAttempts":0,"recoveryOutcome":"not_attempted"}},"mac":"76895bab04b53254704d7a3d28dd4b95fb18c57f4d4cc33aa33fb41424ea0708"}`

const processTestRelayCloseTimeout = 30 * time.Second

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

func TestRunDriverProcessClosesPrivateChannelBeforeWaitingForExit(t *testing.T) {
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
				"FLOW_PRIME_TEST_WAIT_FOR_RELAY_CLOSE=1",
			),
			WorkingDirectory: t.TempDir(),
			UID:              -1, GID: -1,
			MaxDiagnosticBytes: 65536,
		},
	)
	if err != nil {
		t.Fatalf("run half-closed driver process: %v (%q)", err, result.Diagnostic)
	}
	if result.ExitCode != 0 || result.Diagnostic != "" {
		t.Fatalf("half-closed driver result changed: %#v", result)
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

func TestClosedPrimeDriverDiagnosticRequiresOneUniqueCompleteStageLine(t *testing.T) {
	for _, test := range []struct {
		name     string
		value    string
		expected string
		accepted bool
	}{
		{
			name:     "mixed private lines",
			value:    "PRIVATE_PREFIX\nPrime driver stage failure: load-sdk\nPRIVATE_SUFFIX\n",
			expected: "Prime driver stage failure: load-sdk",
			accepted: true,
		},
		{
			name:     "repeated same stage",
			value:    "Prime driver stage failure: load-sdk\nPrime driver stage failure: load-sdk\n",
			expected: "Prime driver stage failure: load-sdk",
			accepted: true,
		},
		{
			name:     "agent SDK stage",
			value:    "Prime driver stage failure: load-agent-sdk\n",
			expected: "Prime driver stage failure: load-agent-sdk",
			accepted: true,
		},
		{
			name:     "AI SDK stage",
			value:    "Prime driver stage failure: load-ai-sdk\n",
			expected: "Prime driver stage failure: load-ai-sdk",
			accepted: true,
		},
		{
			name:     "IPython kernel startup stage",
			value:    "Prime driver stage failure: start-ipython-kernel\n",
			expected: "Prime driver stage failure: start-ipython-kernel",
			accepted: true,
		},
		{
			name:  "conflicting stages",
			value: "Prime driver stage failure: load-sdk\nPrime driver stage failure: initialize-sdk\n",
		},
		{
			name:  "embedded stage",
			value: "PRIVATE Prime driver stage failure: load-sdk PRIVATE\n",
		},
		{
			name:  "unterminated stage",
			value: "Prime driver stage failure: load-sdk",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			observed, accepted := closedPrimeDriverDiagnostic(test.value)
			if accepted != test.accepted || observed != test.expected {
				t.Fatalf("closed driver diagnostic changed: %q %t", observed, accepted)
			}
		})
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

func TestRunDriverProcessDistinguishesClosedChannelSettlement(t *testing.T) {
	for _, test := range []struct {
		name       string
		settlement string
		expected   string
	}{
		{
			name:       "process exit",
			settlement: "exit",
			expected:   "Prime driver exited with code 125",
		},
		{
			name:       "process signal",
			settlement: "signal",
			expected:   "Prime driver was terminated by a signal before terminal settlement",
		},
		{
			name:       "grace deadline",
			settlement: "hang",
			expected:   "Prime driver did not settle after its private channel closed without a diagnostic",
		},
		{
			name:       "grace deadline with private diagnostic",
			settlement: "hang-diagnostic",
			expected:   "Prime driver did not settle after its private channel closed with an unclassified diagnostic",
		},
		{
			name:       "grace deadline with mixed closed stage",
			settlement: "hang-stage",
			expected:   "Prime driver stage failure: load-sdk",
		},
		{
			name:       "authenticated relay failure",
			settlement: "invalid-frame",
			expected:   "Prime driver relay failed while validating a driver frame",
		},
		{
			name:       "host channel EOF",
			settlement: "host-eof",
			expected:   "Prime driver relay failed while reading the host channel",
		},
		{
			name:       "driver channel non-EOF read failure",
			settlement: "oversized-frame",
			expected:   "Prime driver relay failed while reading the driver channel",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
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
						"FLOW_PRIME_TEST_CLOSED_CHANNEL_SETTLEMENT="+test.settlement,
					),
					WorkingDirectory: t.TempDir(),
					UID:              -1, GID: -1,
					MaxDiagnosticBytes: 65536,
				},
			)
			if err == nil || err.Error() != test.expected {
				t.Fatalf("closed driver channel settlement changed: %v", err)
			}
		})
	}
}

func TestSettleDriverProcessAfterRelayFailureUsesOneGraceDeadline(t *testing.T) {
	expected := errors.New("PRIVATE_WAIT_ERROR")
	t.Run("settled child", func(t *testing.T) {
		settled := make(chan error, 1)
		settled <- expected
		killed := false
		waitError, forced := settleDriverProcessAfterRelayFailure(
			settled,
			make(chan time.Time),
			func() error {
				killed = true
				return nil
			},
		)
		if !errors.Is(waitError, expected) || forced || killed {
			t.Fatalf("settled child was killed: %v %t %t", waitError, forced, killed)
		}
	})
	t.Run("grace deadline", func(t *testing.T) {
		settled := make(chan error, 1)
		deadline := make(chan time.Time, 1)
		deadline <- time.Now()
		kills := 0
		waitError, forced := settleDriverProcessAfterRelayFailure(
			settled,
			deadline,
			func() error {
				kills++
				settled <- expected
				return nil
			},
		)
		if !errors.Is(waitError, expected) || !forced || kills != 1 {
			t.Fatalf("unsettled child was not killed once: %v %t %d", waitError, forced, kills)
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
		closeTestDriverChannel(openTestDriverChannel())
		time.Sleep(500 * time.Millisecond)
		fmt.Fprintf(os.Stderr, "Prime driver stage failure: %s\n", stage)
		os.Exit(125)
	}
	if settlement := os.Getenv("FLOW_PRIME_TEST_CLOSED_CHANNEL_SETTLEMENT"); settlement != "" {
		socket := openTestDriverChannel()
		switch settlement {
		case "exit":
			closeTestDriverChannel(socket)
			os.Exit(125)
		case "signal":
			closeTestDriverChannel(socket)
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
			select {}
		case "hang":
			closeTestDriverChannel(socket)
			time.Sleep(1500 * time.Millisecond)
			os.Exit(125)
		case "hang-diagnostic":
			closeTestDriverChannel(socket)
			fmt.Fprintln(os.Stderr, "PRIVATE_UNCLASSIFIED_DIAGNOSTIC")
			time.Sleep(1500 * time.Millisecond)
			os.Exit(125)
		case "hang-stage":
			closeTestDriverChannel(socket)
			fmt.Fprintln(os.Stderr, "PRIVATE_DEPENDENCY_WARNING")
			fmt.Fprintln(os.Stderr, "Prime driver stage failure: load-sdk")
			time.Sleep(1500 * time.Millisecond)
			os.Exit(125)
		case "invalid-frame":
			_, _ = socket.Write([]byte("PRIVATE_INVALID_DRIVER\n"))
			_ = socket.Close()
			os.Exit(125)
		case "host-eof":
			for _, frame := range []string{processTestReady, processTestRequest} {
				if _, err := socket.Write([]byte(frame + "\n")); err != nil {
					os.Exit(123)
				}
			}
			time.Sleep(1500 * time.Millisecond)
			os.Exit(125)
		case "oversized-frame":
			_, _ = socket.Write(bytes.Repeat([]byte("x"), containerprotocol.MaxInnerFrameBytes+2))
			_ = socket.Close()
			os.Exit(125)
		default:
			os.Exit(120)
		}
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
	if os.Getenv("FLOW_PRIME_TEST_WAIT_FOR_RELAY_CLOSE") == "1" {
		if err := syscall.Shutdown(int(socket.Fd()), syscall.SHUT_WR); err != nil {
			os.Exit(124)
		}
		readResult := make(chan error, 1)
		go func() {
			buffer := make([]byte, 1)
			_, readError := socket.Read(buffer)
			readResult <- readError
		}()
		select {
		case err := <-readResult:
			if errors.Is(err, os.ErrClosed) || errors.Is(err, io.EOF) {
				break
			}
			fmt.Fprintln(os.Stderr, "Prime supervisor closed the relay channel incorrectly")
			os.Exit(125)
		case <-time.After(processTestRelayCloseTimeout):
			fmt.Fprintln(os.Stderr, "Prime supervisor did not close the completed relay channel")
			os.Exit(125)
		}
	}
	if err := socket.Close(); err != nil {
		os.Exit(124)
	}
	os.Exit(0)
}

func openTestDriverChannel() *os.File {
	socket := os.NewFile(3, "flow-prime-test-driver")
	if socket == nil {
		os.Exit(121)
	}
	if line, err := bufio.NewReader(socket).ReadString('\n'); err != nil || line != processTestHello+"\n" {
		os.Exit(122)
	}
	return socket
}

func closeTestDriverChannel(socket *os.File) {
	_ = syscall.Shutdown(int(socket.Fd()), syscall.SHUT_RDWR)
	_ = socket.Close()
}
