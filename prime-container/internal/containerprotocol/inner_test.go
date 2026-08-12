package containerprotocol

import (
	"strings"
	"testing"
)

const testInnerSecret = "1111111111111111111111111111111111111111111111111111111111111111"
const testInnerSession = "018f4ee8-9d67-7ca1-a31f-4f3f2388e934"

func TestParseInnerHelloAcceptsTypeScriptSignature(t *testing.T) {
	source := `{"version":1,"sequence":1,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"hello","payload":{"secretHex":"1111111111111111111111111111111111111111111111111111111111111111","trialId":"trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"mac":"47b869ad338a1066ed892cd559e6dd3376fd2a32084409d3d45b512ba406e93c"}`

	hello, err := ParseInnerHello([]byte(source))
	if err != nil {
		t.Fatalf("parse TypeScript hello: %v", err)
	}
	if hello.Sequence != 1 || hello.SessionID != testInnerSession || hello.SecretHex != testInnerSecret {
		t.Fatalf("hello identity changed: %#v", hello)
	}
	if hello.TrialID != "trial-"+strings.Repeat("b", 48) || hello.IdentityDigest != strings.Repeat("e", 64) {
		t.Fatalf("hello payload changed: %#v", hello)
	}
}

func TestParseInnerDriverAcceptsTypeScriptSignatureAndRejectsForgery(t *testing.T) {
	source := `{"version":1,"sequence":1,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"ready","payload":{"trialId":"trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"mac":"d69b44e493b862e87787adc750fdefa7d11666002d3517ff66db3dc7fc9166f6"}`

	frame, err := ParseInnerDriver([]byte(source), InnerExpectation{
		SecretHex: testInnerSecret,
		SessionID: testInnerSession,
		Sequence:  1,
	})
	if err != nil {
		t.Fatalf("parse TypeScript driver frame: %v", err)
	}
	if frame.Type != InnerReady || frame.Sequence != 1 {
		t.Fatalf("driver frame changed: %#v", frame)
	}
	for name, changed := range map[string]string{
		"mac":      strings.Replace(source, "d69b44e4", "069b44e4", 1),
		"sequence": strings.Replace(source, `"sequence":1`, `"sequence":2`, 1),
		"session":  strings.Replace(source, testInnerSession, "018f4ee8-9d67-7ca1-a31f-4f3f2388e935", 1),
		"type":     strings.Replace(source, `"type":"ready"`, `"type":"hello"`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseInnerDriver([]byte(changed), InnerExpectation{
				SecretHex: testInnerSecret,
				SessionID: testInnerSession,
				Sequence:  1,
			}); err == nil {
				t.Fatal("changed driver frame passed")
			}
		})
	}
}

func TestParseInnerDriverAcceptsTypeScriptSignatureWithHTMLSensitivePayload(t *testing.T) {
	const sessionID = "018f4d63-9cc1-7a42-9a32-f31bb25e4c70"
	secretHex := strings.Repeat("ab", 32)
	source := `{"version":1,"sequence":2,"sessionId":"018f4d63-9cc1-7a42-9a32-f31bb25e4c70","type":"inference_request","payload":{"body":"<skill_import> & \u2028"},"mac":"a985265145e8d53de166cb114bd38ff151d99837e1d989315bae6853ff23a78d"}`

	frame, err := ParseInnerDriver([]byte(source), InnerExpectation{
		SecretHex: secretHex,
		SessionID: sessionID,
		Sequence:  2,
	})
	if err != nil {
		t.Fatalf("parse HTML-sensitive TypeScript driver frame: %v", err)
	}
	if frame.Type != InnerInferenceRequest || frame.Sequence != 2 {
		t.Fatalf("HTML-sensitive driver frame changed: %#v", frame)
	}
}

func TestParseInnerParentRequiresTheExpectedDirection(t *testing.T) {
	source := `{"version":1,"sequence":1,"sessionId":"018f4ee8-9d67-7ca1-a31f-4f3f2388e934","type":"hello","payload":{"secretHex":"1111111111111111111111111111111111111111111111111111111111111111","trialId":"trial-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","identityDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"mac":"47b869ad338a1066ed892cd559e6dd3376fd2a32084409d3d45b512ba406e93c"}`

	if _, err := ParseInnerParent([]byte(source), InnerExpectation{
		SecretHex: testInnerSecret,
		SessionID: testInnerSession,
		Sequence:  1,
	}); err == nil {
		t.Fatal("second hello passed as one parent response")
	}
}
