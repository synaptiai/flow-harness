package containerprotocol

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestTransferValidatorAcceptsOneNestedFixture(t *testing.T) {
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
	validator, err := NewTransferValidator(TransferStart{
		EntryCount:     len(entries),
		TotalBytes:     int64(len(content)),
		ManifestSHA256: digest,
	})
	if err != nil {
		t.Fatalf("create validator: %v", err)
	}
	if err := validator.AddEntry(entries[0]); err != nil {
		t.Fatalf("add directory: %v", err)
	}
	if err := validator.AddEntry(entries[1]); err != nil {
		t.Fatalf("add file: %v", err)
	}
	if err := validator.AddChunk(content[:1]); err != nil {
		t.Fatalf("add first chunk: %v", err)
	}
	if err := validator.AddChunk(content[1:]); err != nil {
		t.Fatalf("add second chunk: %v", err)
	}
	if err := validator.EndFile(); err != nil {
		t.Fatalf("end file: %v", err)
	}
	validated, err := validator.Complete()
	if err != nil {
		t.Fatalf("complete fixture: %v", err)
	}
	if len(validated) != len(entries) || validated[1] != entries[1] {
		t.Fatalf("validated entries changed: %#v", validated)
	}
}

func TestTransferValidatorRejectsStructureAndContentDrift(t *testing.T) {
	contentHash := sha256.Sum256([]byte("abc"))
	file := ManifestEntry{
		Path:   "src/a.txt",
		Type:   EntryFile,
		Mode:   0644,
		Size:   3,
		SHA256: hex.EncodeToString(contentHash[:]),
	}
	start := TransferStart{
		EntryCount:     2,
		TotalBytes:     3,
		ManifestSHA256: strings.Repeat("0", 64),
	}
	missingParent, err := NewTransferValidator(start)
	if err != nil {
		t.Fatalf("create validator: %v", err)
	}
	if err := missingParent.AddEntry(file); err == nil {
		t.Fatal("missing parent passed")
	}

	changed, err := NewTransferValidator(start)
	if err != nil {
		t.Fatalf("create changed validator: %v", err)
	}
	if err := changed.AddEntry(ManifestEntry{Path: "src", Type: EntryDirectory, Mode: 0755}); err != nil {
		t.Fatalf("add directory: %v", err)
	}
	if err := changed.AddEntry(file); err != nil {
		t.Fatalf("add file: %v", err)
	}
	if err := changed.AddChunk([]byte("abd")); err != nil {
		t.Fatalf("add changed bytes: %v", err)
	}
	if err := changed.EndFile(); err == nil {
		t.Fatal("changed file digest passed")
	}
}

func TestTransferStartUsesStrictBounds(t *testing.T) {
	start, err := ParseTransferStart([]byte(`{"entryCount":0,"totalBytes":0,"manifestSha256":"` + strings.Repeat("a", 64) + `"}`))
	if err != nil {
		t.Fatalf("parse transfer start: %v", err)
	}
	if start.EntryCount != 0 || start.TotalBytes != 0 {
		t.Fatalf("transfer start changed: %#v", start)
	}
	for _, source := range []string{
		`{"entryCount":4097,"totalBytes":0,"manifestSha256":"` + strings.Repeat("a", 64) + `"}`,
		`{"entryCount":0,"totalBytes":268435457,"manifestSha256":"` + strings.Repeat("a", 64) + `"}`,
		`{"entryCount":0,"entryCount":0,"totalBytes":0,"manifestSha256":"` + strings.Repeat("a", 64) + `"}`,
	} {
		if _, err := ParseTransferStart([]byte(source)); err == nil {
			t.Fatalf("invalid transfer start passed: %s", source)
		}
	}
}
