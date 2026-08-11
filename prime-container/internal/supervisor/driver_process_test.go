package supervisor

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strings"
	"testing"

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
