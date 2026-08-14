package containerprotocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestFrameCodecIsBoundedAndDirectionIndependent(t *testing.T) {
	payload := []byte("ready")
	encoded, err := EncodeFrame(FrameReadiness, payload)
	if err != nil {
		t.Fatalf("encode readiness: %v", err)
	}
	frame, err := ReadFrame(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("read readiness: %v", err)
	}
	if frame.Type != FrameReadiness || !bytes.Equal(frame.Payload, payload) {
		t.Fatalf("frame changed: %#v", frame)
	}
	if _, err := EncodeFrame(FrameFixtureChunk, make([]byte, MaxFileChunkBytes+1)); err == nil {
		t.Fatal("one-over fixture chunk passed")
	}
	if _, err := EncodeFrame(FrameType(255), nil); err == nil {
		t.Fatal("unknown frame type passed")
	}
}

func TestChallengeAndEntriesUseStrictJSON(t *testing.T) {
	challenge, err := ParseReadinessChallenge([]byte(`{"version":1,"containerId":"` + strings.Repeat("a", 64) + `","trialId":"trial-` + strings.Repeat("b", 48) + `","identityDigest":"` + strings.Repeat("c", 64) + `","imageId":"sha256:` + strings.Repeat("d", 64) + `","policyDigest":"` + strings.Repeat("e", 64) + `","imageDeviceMajor":8,"imageDeviceMinor":1}`))
	if err != nil {
		t.Fatalf("parse challenge: %v", err)
	}
	if challenge.Version != 1 || challenge.ContainerID != strings.Repeat("a", 64) {
		t.Fatalf("challenge changed: %#v", challenge)
	}
	for _, source := range []string{
		`{"version":1,"version":1}`,
		`{"version":1,"unexpected":true}`,
	} {
		if _, err := ParseReadinessChallenge([]byte(source)); err == nil {
			t.Fatalf("non-strict challenge passed: %s", source)
		}
	}

	exactPath := strings.Repeat("a", 255)
	for index := 1; index < 16; index++ {
		exactPath += "/" + strings.Repeat("a", 255)
	}
	entry, err := ParseManifestEntry([]byte(`{"path":"` + exactPath + `","type":"directory","mode":365}`))
	if err != nil {
		t.Fatalf("parse exact path: %v", err)
	}
	if entry.Path != exactPath || entry.Mode != 0555 {
		t.Fatalf("entry changed: %#v", entry)
	}
	for _, path := range []string{".flow-prime", "a//b", "a/../b", "a\\\\b", "/a"} {
		if _, err := ParseManifestEntry([]byte(`{"path":"` + path + `","type":"directory","mode":493}`)); err == nil {
			t.Fatalf("invalid path passed: %q", path)
		}
	}
}

func TestManifestDigestMatchesTheHostContract(t *testing.T) {
	content := []byte("abc")
	contentHash := sha256.Sum256(content)
	entries := []ManifestEntry{
		{Path: "src", Type: EntryDirectory, Mode: 0555},
		{
			Path:   "src/a.txt",
			Type:   EntryFile,
			Mode:   0644,
			Size:   int64(len(content)),
			SHA256: hex.EncodeToString(contentHash[:]),
		},
	}
	digest, err := ManifestSHA256(entries)
	if err != nil {
		t.Fatalf("hash manifest: %v", err)
	}
	expected := sha256.Sum256([]byte("directory\x00src\x00365\x00file\x00src/a.txt\x00420\x003\x00" + hex.EncodeToString(contentHash[:]) + "\x00"))
	if digest != hex.EncodeToString(expected[:]) {
		t.Fatalf("manifest digest changed: %s", digest)
	}
}
