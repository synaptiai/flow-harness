package containerprotocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	MaxPayloadBytes        = 1048576
	MaxFileChunkBytes      = 65536
	MaxEntries             = 4096
	MaxPathBytes           = 4095
	MaxPathComponentBytes  = 255
	MaxFileBytes           = 268435456
	MaxTransferBytes       = 268435456
	MaxTransferFrames      = 16385
	MaxChunkFrames         = 8191
	MaxDriverFrames        = 512
	frameHeaderBytes       = 5
	maxStrictJSONDepth     = 8
	maxStrictJSONNodeCount = 128
)

type FrameType byte

const (
	FrameReadiness            FrameType = 1
	FrameFixtureStart         FrameType = 2
	FrameFixtureEntry         FrameType = 3
	FrameFixtureChunk         FrameType = 4
	FrameFixtureFileEnd       FrameType = 5
	FrameFixtureComplete      FrameType = 6
	FrameBootstrap            FrameType = 7
	FrameDriver               FrameType = 8
	FrameTerminal             FrameType = 9
	FrameResultStart          FrameType = 10
	FrameResultEntry          FrameType = 11
	FrameResultChunk          FrameType = 12
	FrameResultFileEnd        FrameType = 13
	FrameResultComplete       FrameType = 14
	FrameSettlement           FrameType = 15
	FrameAttestationChallenge FrameType = 16
)

type Frame struct {
	Type    FrameType
	Payload []byte
}

type ReadinessChallenge struct {
	Version        int    `json:"version"`
	ContainerID    string `json:"containerId"`
	TrialID        string `json:"trialId"`
	IdentityDigest string `json:"identityDigest"`
	ImageID        string `json:"imageId"`
	PolicyDigest   string `json:"policyDigest"`
}

type EntryType string

const (
	EntryDirectory EntryType = "directory"
	EntryFile      EntryType = "file"
)

type ManifestEntry struct {
	Path   string    `json:"path"`
	Type   EntryType `json:"type"`
	Mode   int       `json:"mode"`
	Size   int64     `json:"size,omitempty"`
	SHA256 string    `json:"sha256,omitempty"`
}

type rawManifestEntry struct {
	Path   string    `json:"path"`
	Type   EntryType `json:"type"`
	Mode   int       `json:"mode"`
	Size   *int64    `json:"size,omitempty"`
	SHA256 *string   `json:"sha256,omitempty"`
}

var (
	sha256Pattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	trialIDPattern = regexp.MustCompile(`^trial-[a-f0-9]{48}$`)
	imageIDPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

func EncodeFrame(frameType FrameType, payload []byte) ([]byte, error) {
	if !knownFrameType(frameType) {
		return nil, fmt.Errorf("unknown Prime container frame type: %d", frameType)
	}
	if err := validatePayloadLength(frameType, len(payload)); err != nil {
		return nil, err
	}
	encoded := make([]byte, frameHeaderBytes+len(payload))
	encoded[0] = byte(frameType)
	binary.BigEndian.PutUint32(encoded[1:], uint32(len(payload)))
	copy(encoded[frameHeaderBytes:], payload)
	return encoded, nil
}

func WriteFrame(writer io.Writer, frameType FrameType, payload []byte) error {
	encoded, err := EncodeFrame(frameType, payload)
	if err != nil {
		return err
	}
	if _, err := writer.Write(encoded); err != nil {
		return fmt.Errorf("write Prime container frame: %w", err)
	}
	return nil
}

func ReadFrame(reader io.Reader) (Frame, error) {
	header := make([]byte, frameHeaderBytes)
	if _, err := io.ReadFull(reader, header); err != nil {
		return Frame{}, fmt.Errorf("read Prime container frame header: %w", err)
	}
	frameType := FrameType(header[0])
	if !knownFrameType(frameType) {
		return Frame{}, fmt.Errorf("unknown Prime container frame type: %d", frameType)
	}
	payloadLength := int(binary.BigEndian.Uint32(header[1:]))
	if err := validatePayloadLength(frameType, payloadLength); err != nil {
		return Frame{}, err
	}
	payload := make([]byte, payloadLength)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return Frame{}, fmt.Errorf("read Prime container frame payload: %w", err)
	}
	return Frame{Type: frameType, Payload: payload}, nil
}

func ParseReadinessChallenge(source []byte) (ReadinessChallenge, error) {
	var challenge ReadinessChallenge
	if err := decodeStrictJSON(source, &challenge); err != nil {
		return ReadinessChallenge{}, fmt.Errorf("parse Prime readiness challenge: %w", err)
	}
	if challenge.Version != 1 ||
		!sha256Pattern.MatchString(challenge.ContainerID) ||
		!trialIDPattern.MatchString(challenge.TrialID) ||
		!sha256Pattern.MatchString(challenge.IdentityDigest) ||
		!imageIDPattern.MatchString(challenge.ImageID) ||
		!sha256Pattern.MatchString(challenge.PolicyDigest) {
		return ReadinessChallenge{}, errors.New("Prime readiness challenge violates the closed schema")
	}
	return challenge, nil
}

func ParseManifestEntry(source []byte) (ManifestEntry, error) {
	var raw rawManifestEntry
	if err := decodeStrictJSON(source, &raw); err != nil {
		return ManifestEntry{}, fmt.Errorf("parse Prime manifest entry: %w", err)
	}
	if err := validatePath(raw.Path); err != nil {
		return ManifestEntry{}, err
	}
	if raw.Mode < 0 || raw.Mode > 0777 {
		return ManifestEntry{}, errors.New("Prime manifest entry mode is outside 0000 through 0777")
	}
	entry := ManifestEntry{Path: raw.Path, Type: raw.Type, Mode: raw.Mode}
	switch raw.Type {
	case EntryDirectory:
		if raw.Size != nil || raw.SHA256 != nil {
			return ManifestEntry{}, errors.New("Prime directory entry contains file fields")
		}
	case EntryFile:
		if raw.Size == nil || *raw.Size < 0 || *raw.Size > MaxFileBytes {
			return ManifestEntry{}, errors.New("Prime file entry size is invalid")
		}
		if raw.SHA256 == nil || !sha256Pattern.MatchString(*raw.SHA256) {
			return ManifestEntry{}, errors.New("Prime file entry SHA-256 is invalid")
		}
		entry.Size = *raw.Size
		entry.SHA256 = *raw.SHA256
	default:
		return ManifestEntry{}, errors.New("Prime manifest entry type is invalid")
	}
	return entry, nil
}

func ManifestSHA256(entries []ManifestEntry) (string, error) {
	hash := sha256.New()
	for _, entry := range entries {
		if err := validatePath(entry.Path); err != nil {
			return "", err
		}
		switch entry.Type {
		case EntryDirectory:
			fmt.Fprintf(hash, "directory\x00%s\x00%d\x00", entry.Path, entry.Mode)
		case EntryFile:
			if entry.Size < 0 || entry.Size > MaxFileBytes || !sha256Pattern.MatchString(entry.SHA256) {
				return "", errors.New("Prime file entry is invalid")
			}
			fmt.Fprintf(hash, "file\x00%s\x00%d\x00%d\x00%s\x00", entry.Path, entry.Mode, entry.Size, entry.SHA256)
		default:
			return "", errors.New("Prime manifest entry type is invalid")
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func knownFrameType(frameType FrameType) bool {
	return frameType >= FrameReadiness && frameType <= FrameAttestationChallenge
}

func validatePayloadLength(frameType FrameType, length int) error {
	if length < 0 || length > MaxPayloadBytes {
		return errors.New("Prime container frame payload exceeds the byte limit")
	}
	if (frameType == FrameFixtureChunk || frameType == FrameResultChunk) && length > MaxFileChunkBytes {
		return errors.New("Prime container file chunk exceeds the byte limit")
	}
	return nil
}

func validatePath(path string) error {
	if !utf8.ValidString(path) || len(path) < 1 || len(path) > MaxPathBytes {
		return errors.New("Prime container path exceeds the UTF-8 byte limit")
	}
	if strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\x00") {
		return errors.New("Prime container path must be portable and relative")
	}
	components := strings.Split(path, "/")
	for _, component := range components {
		if component == "" || component == "." || component == ".." {
			return errors.New("Prime container path contains an invalid component")
		}
		if len(component) > MaxPathComponentBytes {
			return errors.New("Prime container path component exceeds the UTF-8 byte limit")
		}
	}
	if components[0] == ".flow-prime" {
		return errors.New("Prime container path uses the reserved .flow-prime path")
	}
	return nil
}

func decodeStrictJSON(source []byte, destination any) error {
	if !utf8.Valid(source) {
		return errors.New("JSON is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.UseNumber()
	nodes := 0
	if err := consumeJSONValue(decoder, 0, &nodes); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON has trailing data")
		}
		return err
	}
	typed := json.NewDecoder(bytes.NewReader(source))
	typed.DisallowUnknownFields()
	if err := typed.Decode(destination); err != nil {
		return err
	}
	if err := typed.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON has trailing data")
	}
	return nil
}

func consumeJSONValue(decoder *json.Decoder, depth int, nodes *int) error {
	if depth > maxStrictJSONDepth {
		return errors.New("JSON exceeds the depth limit")
	}
	*nodes++
	if *nodes > maxStrictJSONNodeCount {
		return errors.New("JSON exceeds the node limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		keys := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is invalid")
			}
			if _, exists := keys[key]; exists {
				return fmt.Errorf("JSON object contains duplicate key %q", key)
			}
			keys[key] = struct{}{}
			if err := consumeJSONValue(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
	default:
		return errors.New("JSON contains an unexpected delimiter")
	}
	closing, err := decoder.Token()
	if err != nil {
		return err
	}
	expected := json.Delim('}')
	if delimiter == '[' {
		expected = ']'
	}
	if closing != expected {
		return errors.New("JSON container is not closed")
	}
	return nil
}
