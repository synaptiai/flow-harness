package containerprotocol

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"unicode/utf8"
)

const MaxInnerFrameBytes = 1048576

type InnerFrameType string

const (
	InnerHello             InnerFrameType = "hello"
	InnerInferenceResponse InnerFrameType = "inference_response"
	InnerCancel            InnerFrameType = "cancel"
	InnerReady             InnerFrameType = "ready"
	InnerEvent             InnerFrameType = "event"
	InnerInferenceRequest  InnerFrameType = "inference_request"
	InnerTerminal          InnerFrameType = "terminal"
)

type InnerExpectation struct {
	SecretHex string
	SessionID string
	Sequence  int64
}

type InnerFrame struct {
	Sequence  int64
	SessionID string
	Type      InnerFrameType
	Payload   []byte
}

type InnerHelloFrame struct {
	InnerFrame
	SecretHex      string
	TrialID        string
	IdentityDigest string
}

type rawInnerFrame struct {
	Version   int             `json:"version"`
	Sequence  int64           `json:"sequence"`
	SessionID string          `json:"sessionId"`
	Type      InnerFrameType  `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	MAC       string          `json:"mac"`
}

type rawHelloPayload struct {
	SecretHex      string          `json:"secretHex"`
	TrialID        string          `json:"trialId"`
	IdentityDigest string          `json:"identityDigest"`
	Evaluation     json.RawMessage `json:"evaluation,omitempty"`
	Instruction    *string         `json:"instructionText,omitempty"`
}

func ParseInnerHello(source []byte) (InnerHelloFrame, error) {
	raw, canonical, err := parseRawInnerFrame(source)
	if err != nil {
		return InnerHelloFrame{}, err
	}
	if raw.Type != InnerHello || raw.Sequence != 1 {
		return InnerHelloFrame{}, errors.New("Prime inner bootstrap is not hello sequence 1")
	}
	var payload rawHelloPayload
	if err := decodeStrictJSON(raw.Payload, &payload); err != nil {
		return InnerHelloFrame{}, fmt.Errorf("parse Prime inner hello payload: %w", err)
	}
	if !sha256Pattern.MatchString(payload.SecretHex) ||
		!trialIDPattern.MatchString(payload.TrialID) ||
		!sha256Pattern.MatchString(payload.IdentityDigest) {
		return InnerHelloFrame{}, errors.New("Prime inner hello identity violates the closed schema")
	}
	if err := verifyInnerMAC(raw.MAC, payload.SecretHex, canonical); err != nil {
		return InnerHelloFrame{}, err
	}
	return InnerHelloFrame{
		InnerFrame: InnerFrame{
			Sequence: raw.Sequence, SessionID: raw.SessionID, Type: raw.Type,
			Payload: append([]byte(nil), raw.Payload...),
		},
		SecretHex: payload.SecretHex, TrialID: payload.TrialID, IdentityDigest: payload.IdentityDigest,
	}, nil
}

func ParseInnerDriver(source []byte, expected InnerExpectation) (InnerFrame, error) {
	return parseExpectedInnerFrame(source, expected, map[InnerFrameType]bool{
		InnerReady: true, InnerEvent: true, InnerInferenceRequest: true, InnerTerminal: true,
	})
}

func ParseInnerParent(source []byte, expected InnerExpectation) (InnerFrame, error) {
	return parseExpectedInnerFrame(source, expected, map[InnerFrameType]bool{
		InnerInferenceResponse: true, InnerCancel: true,
	})
}

func parseExpectedInnerFrame(
	source []byte,
	expected InnerExpectation,
	allowed map[InnerFrameType]bool,
) (InnerFrame, error) {
	if !sha256Pattern.MatchString(expected.SecretHex) ||
		!uuidPattern.MatchString(expected.SessionID) ||
		expected.Sequence < 1 {
		return InnerFrame{}, errors.New("Prime inner frame expectation is invalid")
	}
	raw, canonical, err := parseRawInnerFrame(source)
	if err != nil {
		return InnerFrame{}, err
	}
	if !allowed[raw.Type] {
		return InnerFrame{}, fmt.Errorf("Prime inner frame type %q has the wrong direction", raw.Type)
	}
	if raw.SessionID != expected.SessionID || raw.Sequence != expected.Sequence {
		return InnerFrame{}, errors.New("Prime inner frame identity or sequence changed")
	}
	if err := verifyInnerMAC(raw.MAC, expected.SecretHex, canonical); err != nil {
		return InnerFrame{}, err
	}
	return InnerFrame{
		Sequence: raw.Sequence, SessionID: raw.SessionID, Type: raw.Type,
		Payload: append([]byte(nil), raw.Payload...),
	}, nil
}

func parseRawInnerFrame(source []byte) (rawInnerFrame, []byte, error) {
	if len(source) < 1 || len(source) > MaxInnerFrameBytes || !utf8.Valid(source) || bytes.ContainsAny(source, "\r\n") {
		return rawInnerFrame{}, nil, errors.New("Prime inner frame must be one bounded UTF-8 line")
	}
	var raw rawInnerFrame
	if err := decodeStrictJSON(source, &raw); err != nil {
		return rawInnerFrame{}, nil, fmt.Errorf("parse Prime inner frame: %w", err)
	}
	if raw.Version != 1 || raw.Sequence < 1 || raw.Sequence > 9007199254740991 ||
		!uuidPattern.MatchString(raw.SessionID) || !sha256Pattern.MatchString(raw.MAC) || len(raw.Payload) < 2 {
		return rawInnerFrame{}, nil, errors.New("Prime inner frame violates the closed envelope schema")
	}
	var value map[string]any
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return rawInnerFrame{}, nil, errors.New("Prime inner frame cannot be canonicalized")
	}
	delete(value, "mac")
	canonical, err := canonicalJSON(value)
	if err != nil {
		return rawInnerFrame{}, nil, err
	}
	return raw, canonical, nil
}

func verifyInnerMAC(observedHex string, secretHex string, canonical []byte) error {
	secret, err := hex.DecodeString(secretHex)
	if err != nil || len(secret) != sha256.Size {
		return errors.New("Prime inner protocol secret is invalid")
	}
	observed, err := hex.DecodeString(observedHex)
	if err != nil || len(observed) != sha256.Size {
		return errors.New("Prime inner frame authentication code is invalid")
	}
	digest := hmac.New(sha256.New, secret)
	_, _ = digest.Write(canonical)
	if !hmac.Equal(observed, digest.Sum(nil)) {
		return errors.New("Prime inner frame authentication code is invalid")
	}
	return nil
}

func canonicalJSON(value any) ([]byte, error) {
	var output bytes.Buffer
	if err := writeCanonicalJSON(&output, value); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func writeCanonicalJSON(output *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		output.WriteString("null")
	case bool:
		output.WriteString(strconv.FormatBool(typed))
	case string:
		encoded, _ := json.Marshal(typed)
		output.Write(encoded)
	case json.Number:
		if _, err := strconv.ParseFloat(typed.String(), 64); err != nil {
			return errors.New("Prime inner frame contains an invalid number")
		}
		output.WriteString(typed.String())
	case []any:
		output.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeCanonicalJSON(output, item); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			encoded, _ := json.Marshal(key)
			output.Write(encoded)
			output.WriteByte(':')
			if err := writeCanonicalJSON(output, typed[key]); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	default:
		return fmt.Errorf("Prime inner frame contains unsupported JSON value %T", value)
	}
	return nil
}
