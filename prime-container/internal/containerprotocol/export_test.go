package containerprotocol

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceExporterOmitsControlStateAndProducesAValidTransfer(t *testing.T) {
	rootPath := t.TempDir()
	if err := os.MkdirAll(filepath.Join(rootPath, ".flow-prime", "control"), 0700); err != nil {
		t.Fatalf("create control state: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootPath, ".flow-prime", "control", "secret"), []byte("private"), 0600); err != nil {
		t.Fatalf("write control state: %v", err)
	}
	if err := os.Mkdir(filepath.Join(rootPath, "src"), 0755); err != nil {
		t.Fatalf("create result directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootPath, "src", "RESULT.md"), []byte("DONE\n"), 0640); err != nil {
		t.Fatalf("write result file: %v", err)
	}

	export, err := CaptureWorkspace(rootPath)
	if err != nil {
		t.Fatalf("capture workspace: %v", err)
	}
	if len(export.Entries) != 2 || export.Entries[0].Path != "src" || export.Entries[1].Path != "src/RESULT.md" {
		t.Fatalf("captured entries changed: %#v", export.Entries)
	}
	if export.Entries[1].Mode != 0640 {
		t.Fatalf("result mode changed: %o", export.Entries[1].Mode)
	}
	var encoded bytes.Buffer
	if err := export.WriteResultFrames(&encoded); err != nil {
		t.Fatalf("write result transfer: %v", err)
	}
	validator, err := NewTransferValidator(export.Start)
	if err != nil {
		t.Fatalf("create result validator: %v", err)
	}
	for frameIndex := 0; ; frameIndex++ {
		frame, err := ReadFrame(&encoded)
		if err != nil {
			t.Fatalf("read result frame %d: %v", frameIndex, err)
		}
		switch frame.Type {
		case FrameResultStart:
			start, err := ParseTransferStart(frame.Payload)
			if err != nil || start != export.Start {
				t.Fatalf("result start changed: %#v %v", start, err)
			}
		case FrameResultEntry:
			entry, err := ParseManifestEntry(frame.Payload)
			if err != nil || validator.AddEntry(entry) != nil {
				t.Fatalf("result entry failed: %#v %v", entry, err)
			}
		case FrameResultChunk:
			if err := validator.AddChunk(frame.Payload); err != nil {
				t.Fatalf("result chunk failed: %v", err)
			}
		case FrameResultFileEnd:
			if err := validator.EndFile(); err != nil {
				t.Fatalf("result file end failed: %v", err)
			}
		case FrameResultComplete:
			if _, err := validator.Complete(); err != nil {
				t.Fatalf("complete result transfer: %v", err)
			}
			if encoded.Len() != 0 {
				t.Fatalf("result transfer has %d trailing bytes", encoded.Len())
			}
			return
		default:
			t.Fatalf("unexpected result frame: %d", frame.Type)
		}
	}
}

func TestWorkspaceExporterRejectsLinks(t *testing.T) {
	rootPath := t.TempDir()
	if err := os.Symlink("outside", filepath.Join(rootPath, "linked")); err != nil {
		t.Fatalf("create result link: %v", err)
	}
	if _, err := CaptureWorkspace(rootPath); err == nil {
		t.Fatal("result link passed capture")
	}
}
