package containerprotocol

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
)

func TestRelayDriverReportsClosedStages(t *testing.T) {
	hello := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 1, "sessionId": testInnerSession, "type": "hello",
		"payload": map[string]any{
			"secretHex":      testInnerSecret,
			"trialId":        "trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"identityDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		},
	})
	ready := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 1, "sessionId": testInnerSession, "type": "ready",
		"payload": map[string]any{
			"trialId":        "trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"identityDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		},
	})
	request := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 2, "sessionId": testInnerSession, "type": "inference_request",
		"payload": map[string]any{
			"requestId": "018f4ee8-9d67-7ca1-a31f-4f3f2388e935",
			"body":      "{}", "bodySha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
		},
	})

	tests := []struct {
		name    string
		host    []byte
		driver  [][]byte
		hello   []byte
		message string
	}{
		{
			name: "bootstrap validation", hello: []byte("PRIVATE_INVALID_BOOTSTRAP"),
			message: "Prime driver relay failed while validating bootstrap",
		},
		{
			name: "driver read", hello: hello,
			message: "Prime driver relay failed while reading the driver channel",
		},
		{
			name: "driver validation", hello: hello, driver: [][]byte{[]byte("PRIVATE_INVALID_DRIVER")},
			message: "Prime driver relay failed while validating a driver frame",
		},
		{
			name: "host read", hello: hello, driver: [][]byte{ready, request},
			message: "Prime driver relay failed while reading the host channel",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			supervisorSide, driverSide := net.Pipe()
			defer supervisorSide.Close()
			go func() {
				defer driverSide.Close()
				reader := bufio.NewReader(driverSide)
				if _, err := reader.ReadBytes('\n'); err != nil {
					return
				}
				for _, frame := range test.driver {
					if _, err := driverSide.Write(append(append([]byte(nil), frame...), '\n')); err != nil {
						return
					}
				}
			}()
			err := RelayDriver(bytes.NewReader(test.host), io.Discard, supervisorSide, test.hello)
			if err == nil || err.Error() != test.message {
				t.Fatalf("relay stage changed: %v", err)
			}
			if strings.Contains(err.Error(), "PRIVATE") {
				t.Fatalf("relay stage exposed a private value: %v", err)
			}
		})
	}
}

func TestRelayDriverAuthenticatesAndRelaysOneInference(t *testing.T) {
	hello := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 1, "sessionId": testInnerSession, "type": "hello",
		"payload": map[string]any{
			"secretHex":      testInnerSecret,
			"trialId":        "trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"identityDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		},
	})
	ready := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 1, "sessionId": testInnerSession, "type": "ready",
		"payload": map[string]any{
			"trialId":        "trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"identityDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		},
	})
	request := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 2, "sessionId": testInnerSession, "type": "inference_request",
		"payload": map[string]any{
			"requestId": "018f4ee8-9d67-7ca1-a31f-4f3f2388e935",
			"body":      "{}", "bodySha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
		},
	})
	response := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 2, "sessionId": testInnerSession, "type": "inference_response",
		"payload": map[string]any{
			"requestId": "018f4ee8-9d67-7ca1-a31f-4f3f2388e935",
			"body":      "{}", "bodySha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
		},
	})
	terminal := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 3, "sessionId": testInnerSession, "type": "terminal",
		"payload": map[string]any{
			"harness": map[string]any{"outcome": "completed"},
			"metrics": map[string]any{"turns": 1},
		},
	})
	var hostInput bytes.Buffer
	writeRawFrame(t, &hostInput, FrameDriver, response)
	var hostOutput bytes.Buffer
	supervisorSide, driverSide := net.Pipe()
	defer supervisorSide.Close()
	driverDone := make(chan error, 1)
	go func() {
		defer driverSide.Close()
		reader := bufio.NewReader(driverSide)
		bootstrap, err := reader.ReadBytes('\n')
		if err != nil {
			driverDone <- err
			return
		}
		if !bytes.Equal(bootstrap, append(append([]byte(nil), hello...), '\n')) {
			driverDone <- &relayTestError{"bootstrap changed"}
			return
		}
		for _, frame := range [][]byte{ready, request} {
			if _, err := driverSide.Write(append(append([]byte(nil), frame...), '\n')); err != nil {
				driverDone <- err
				return
			}
		}
		parent, err := reader.ReadBytes('\n')
		if err != nil {
			driverDone <- err
			return
		}
		if !bytes.Equal(parent, append(append([]byte(nil), response...), '\n')) {
			driverDone <- &relayTestError{"inference response changed"}
			return
		}
		_, err = driverSide.Write(append(append([]byte(nil), terminal...), '\n'))
		driverDone <- err
	}()

	if err := RelayDriver(&hostInput, &hostOutput, supervisorSide, hello); err != nil {
		t.Fatalf("relay driver: %v", err)
	}
	if err := <-driverDone; err != nil {
		t.Fatalf("driver fixture: %v", err)
	}
	for index, expected := range []struct {
		typeValue FrameType
		payload   []byte
	}{
		{FrameDriver, ready},
		{FrameDriver, request},
		{FrameDriver, terminal},
		{FrameTerminal, nil},
	} {
		frame, err := ReadFrame(&hostOutput)
		if err != nil || frame.Type != expected.typeValue || !bytes.Equal(frame.Payload, expected.payload) {
			t.Fatalf("output frame %d changed: %#v %v", index, frame, err)
		}
	}
	if hostOutput.Len() != 0 {
		t.Fatalf("relay output has %d trailing bytes", hostOutput.Len())
	}
}

func TestRelayDriverRejectsTerminalBeforeReady(t *testing.T) {
	hello := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 1, "sessionId": testInnerSession, "type": "hello",
		"payload": map[string]any{
			"secretHex":      testInnerSecret,
			"trialId":        "trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"identityDigest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		},
	})
	terminal := signTestInnerFrame(t, testInnerSecret, map[string]any{
		"version": 1, "sequence": 1, "sessionId": testInnerSession, "type": "terminal",
		"payload": map[string]any{"harness": map[string]any{}, "metrics": map[string]any{}},
	})
	supervisorSide, driverSide := net.Pipe()
	defer supervisorSide.Close()
	go func() {
		defer driverSide.Close()
		reader := bufio.NewReader(driverSide)
		_, _ = reader.ReadBytes('\n')
		_, _ = driverSide.Write(append(terminal, '\n'))
	}()

	if err := RelayDriver(&bytes.Buffer{}, &bytes.Buffer{}, supervisorSide, hello); err == nil {
		t.Fatal("terminal before ready passed")
	}
}

type relayTestError struct{ message string }

func (error *relayTestError) Error() string { return error.message }

func signTestInnerFrame(t *testing.T, secretHex string, unsigned map[string]any) []byte {
	t.Helper()
	encodedUnsigned, err := json.Marshal(unsigned)
	if err != nil {
		t.Fatalf("encode unsigned test frame: %v", err)
	}
	var normalized map[string]any
	decoder := json.NewDecoder(bytes.NewReader(encodedUnsigned))
	decoder.UseNumber()
	if err := decoder.Decode(&normalized); err != nil {
		t.Fatalf("normalize unsigned test frame: %v", err)
	}
	canonical, err := canonicalJSON(normalized)
	if err != nil {
		t.Fatalf("canonicalize test frame: %v", err)
	}
	secret, err := hex.DecodeString(secretHex)
	if err != nil {
		t.Fatalf("decode test secret: %v", err)
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(canonical)
	frame := make(map[string]any, len(normalized)+1)
	for key, value := range normalized {
		frame[key] = value
	}
	frame["mac"] = hex.EncodeToString(mac.Sum(nil))
	encoded, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("encode test frame: %v", err)
	}
	return encoded
}
