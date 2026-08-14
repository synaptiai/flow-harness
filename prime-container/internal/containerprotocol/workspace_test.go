package containerprotocol

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceImporterDefersDirectoryModesAndSettlesOwnership(t *testing.T) {
	rootPath := t.TempDir()
	t.Cleanup(func() {
		_ = os.Chmod(filepath.Join(rootPath, "readonly"), 0700)
	})
	content := []byte("task\n")
	contentHash := sha256.Sum256(content)
	entries := []ManifestEntry{
		{Path: "readonly", Type: EntryDirectory, Mode: 0555},
		{
			Path:   "readonly/TASK.md",
			Type:   EntryFile,
			Mode:   0400,
			Size:   int64(len(content)),
			SHA256: hex.EncodeToString(contentHash[:]),
		},
	}
	start := startForEntries(t, entries)
	importer, err := NewWorkspaceImporter(rootPath, start, WorkspaceOwnership{
		EntryUID: os.Getuid(),
		EntryGID: os.Getgid(),
		RootUID:  os.Getuid(),
		RootGID:  os.Getgid(),
		RootMode: 0710,
	})
	if err != nil {
		t.Fatalf("create importer: %v", err)
	}
	defer importer.Close()
	if err := importer.AddEntry(entries[0]); err != nil {
		t.Fatalf("add read-only directory: %v", err)
	}
	if err := importer.AddEntry(entries[1]); err != nil {
		t.Fatalf("add child file: %v", err)
	}
	if err := importer.AddChunk(content); err != nil {
		t.Fatalf("write child file: %v", err)
	}
	if err := importer.EndFile(); err != nil {
		t.Fatalf("end child file: %v", err)
	}
	if _, err := importer.Complete(); err != nil {
		t.Fatalf("complete import: %v", err)
	}

	directory, err := os.Stat(filepath.Join(rootPath, "readonly"))
	if err != nil {
		t.Fatalf("stat directory: %v", err)
	}
	file, err := os.Stat(filepath.Join(rootPath, "readonly", "TASK.md"))
	if err != nil {
		t.Fatalf("stat file: %v", err)
	}
	if directory.Mode().Perm() != 0555 || file.Mode().Perm() != 0400 {
		t.Fatalf("settled modes changed: directory=%o file=%o", directory.Mode().Perm(), file.Mode().Perm())
	}
	actual, err := os.ReadFile(filepath.Join(rootPath, "readonly", "TASK.md"))
	if err != nil {
		t.Fatalf("read settled file: %v", err)
	}
	if string(actual) != string(content) {
		t.Fatalf("settled content changed: %q", actual)
	}
}

func TestWorkspaceImporterRejectsPreexistingOrLinkedPaths(t *testing.T) {
	rootPath := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(rootPath, "src")); err != nil {
		t.Fatalf("create hostile fixture link: %v", err)
	}
	entry := ManifestEntry{Path: "src", Type: EntryDirectory, Mode: 0755}
	start := startForEntries(t, []ManifestEntry{entry})
	importer, err := NewWorkspaceImporter(rootPath, start, WorkspaceOwnership{
		EntryUID: os.Getuid(),
		EntryGID: os.Getgid(),
		RootUID:  os.Getuid(),
		RootGID:  os.Getgid(),
		RootMode: 0710,
	})
	if err != nil {
		t.Fatalf("create importer: %v", err)
	}
	defer importer.Close()
	if err := importer.AddEntry(entry); err == nil {
		t.Fatal("preexisting link passed fixture import")
	}
}

func startForEntries(t *testing.T, entries []ManifestEntry) TransferStart {
	t.Helper()
	digest, err := ManifestSHA256(entries)
	if err != nil {
		t.Fatalf("hash fixture: %v", err)
	}
	totalBytes := int64(0)
	for _, entry := range entries {
		if entry.Type == EntryFile {
			totalBytes += entry.Size
		}
	}
	return TransferStart{
		EntryCount:     len(entries),
		TotalBytes:     totalBytes,
		ManifestSHA256: digest,
	}
}
