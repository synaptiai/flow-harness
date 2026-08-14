package containerprotocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReceivePreparationImportsFixtureAndReturnsBootstrap(t *testing.T) {
	workspace := t.TempDir()
	content := []byte("PENDING\n")
	contentDigest := sha256.Sum256(content)
	entries := []ManifestEntry{{
		Path:   "RESULT.md",
		Type:   EntryFile,
		Mode:   0640,
		Size:   int64(len(content)),
		SHA256: hex.EncodeToString(contentDigest[:]),
	}}
	manifestDigest, err := ManifestSHA256(entries)
	if err != nil {
		t.Fatalf("create fixture manifest: %v", err)
	}
	start := TransferStart{
		EntryCount:     len(entries),
		TotalBytes:     int64(len(content)),
		ManifestSHA256: manifestDigest,
	}
	challenge := validReadinessChallenge()
	bootstrap := []byte(`{"version":1,"sequence":1,"type":"hello"}`)
	var input bytes.Buffer
	writeJSONFrame(t, &input, FrameAttestationChallenge, challenge)
	writeJSONFrame(t, &input, FrameFixtureStart, start)
	writeJSONFrame(t, &input, FrameFixtureEntry, entries[0])
	writeRawFrame(t, &input, FrameFixtureChunk, content)
	writeRawFrame(t, &input, FrameFixtureFileEnd, nil)
	writeRawFrame(t, &input, FrameFixtureComplete, nil)
	writeRawFrame(t, &input, FrameBootstrap, bootstrap)
	var output bytes.Buffer

	prepared, err := ReceivePreparation(PreparationInput{
		Reader:        &input,
		Writer:        &output,
		WorkspacePath: workspace,
		Ownership: WorkspaceOwnership{
			EntryUID: os.Getuid(),
			EntryGID: os.Getgid(),
			RootUID:  os.Getuid(),
			RootGID:  os.Getgid(),
			RootMode: 0750,
		},
		Readiness: func(received ReadinessChallenge) ([]byte, error) {
			if received != challenge {
				t.Fatalf("challenge changed: %#v", received)
			}
			return []byte(`{"version":1,"ready":true}`), nil
		},
	})
	if err != nil {
		t.Fatalf("receive preparation: %v", err)
	}
	if !bytes.Equal(prepared.Bootstrap, bootstrap) {
		t.Fatalf("bootstrap changed: %q", prepared.Bootstrap)
	}
	written, err := os.ReadFile(filepath.Join(workspace, "RESULT.md"))
	if err != nil || !bytes.Equal(written, content) {
		t.Fatalf("fixture import changed: %q %v", written, err)
	}
	if information, err := os.Stat(filepath.Join(workspace, "RESULT.md")); err != nil || information.Mode().Perm() != 0640 {
		t.Fatalf("fixture mode changed: %v %v", information, err)
	}
	frame, err := ReadFrame(&output)
	if err != nil || frame.Type != FrameReadiness || string(frame.Payload) != `{"version":1,"ready":true}` {
		t.Fatalf("readiness changed: %#v %v", frame, err)
	}
	if output.Len() != 0 {
		t.Fatalf("readiness output has %d trailing bytes", output.Len())
	}
}

func TestReceivePreparationRejectsInvalidOrderAndTrailingBootstrapLines(t *testing.T) {
	for name, build := range map[string]func(*testing.T, *bytes.Buffer){
		"fixture before challenge": func(t *testing.T, input *bytes.Buffer) {
			writeRawFrame(t, input, FrameFixtureComplete, nil)
		},
		"bootstrap with newline": func(t *testing.T, input *bytes.Buffer) {
			writeJSONFrame(t, input, FrameAttestationChallenge, validReadinessChallenge())
			emptyDigest, err := ManifestSHA256(nil)
			if err != nil {
				t.Fatal(err)
			}
			writeJSONFrame(t, input, FrameFixtureStart, TransferStart{ManifestSHA256: emptyDigest})
			writeRawFrame(t, input, FrameFixtureComplete, nil)
			writeRawFrame(t, input, FrameBootstrap, []byte("{}\n{}"))
		},
	} {
		t.Run(name, func(t *testing.T) {
			var input bytes.Buffer
			build(t, &input)
			_, err := ReceivePreparation(PreparationInput{
				Reader:        &input,
				Writer:        &bytes.Buffer{},
				WorkspacePath: t.TempDir(),
				Ownership: WorkspaceOwnership{
					EntryUID: os.Getuid(), EntryGID: os.Getgid(),
					RootUID: os.Getuid(), RootGID: os.Getgid(), RootMode: 0750,
				},
				Readiness: func(ReadinessChallenge) ([]byte, error) { return []byte(`{}`), nil },
			})
			if err == nil {
				t.Fatal("invalid preparation passed")
			}
		})
	}
}

func validReadinessChallenge() ReadinessChallenge {
	return ReadinessChallenge{
		Version:          1,
		ContainerID:      strings.Repeat("a", 64),
		TrialID:          "trial-" + strings.Repeat("b", 48),
		IdentityDigest:   strings.Repeat("c", 64),
		ImageID:          "sha256:" + strings.Repeat("d", 64),
		PolicyDigest:     strings.Repeat("e", 64),
		ImageDeviceMajor: 8,
		ImageDeviceMinor: 1,
	}
}

func writeJSONFrame(t *testing.T, writer *bytes.Buffer, frameType FrameType, value any) {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode frame payload: %v", err)
	}
	writeRawFrame(t, writer, frameType, payload)
}

func writeRawFrame(t *testing.T, writer *bytes.Buffer, frameType FrameType, payload []byte) {
	t.Helper()
	if err := WriteFrame(writer, frameType, payload); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}
