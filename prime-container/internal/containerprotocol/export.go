package containerprotocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
)

type WorkspaceExport struct {
	Start   TransferStart
	Entries []ManifestEntry
	root    string
}

func CaptureWorkspace(rootPath string) (*WorkspaceExport, error) {
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, fmt.Errorf("open Prime result root: %w", err)
	}
	defer root.Close()
	entries := make([]ManifestEntry, 0)
	totalBytes := int64(0)
	if err := captureDirectory(root, ".", &entries, &totalBytes); err != nil {
		return nil, err
	}
	sort.Slice(entries, func(left int, right int) bool {
		return bytes.Compare([]byte(entries[left].Path), []byte(entries[right].Path)) < 0
	})
	if len(entries) > MaxEntries {
		return nil, errors.New("Prime result has too many entries")
	}
	manifestDigest, err := ManifestSHA256(entries)
	if err != nil {
		return nil, err
	}
	return &WorkspaceExport{
		Start: TransferStart{
			EntryCount:     len(entries),
			TotalBytes:     totalBytes,
			ManifestSHA256: manifestDigest,
		},
		Entries: append([]ManifestEntry(nil), entries...),
		root:    rootPath,
	}, nil
}

func (export *WorkspaceExport) WriteResultFrames(writer io.Writer) error {
	root, err := os.OpenRoot(export.root)
	if err != nil {
		return fmt.Errorf("reopen Prime result root: %w", err)
	}
	defer root.Close()
	startPayload, err := json.Marshal(export.Start)
	if err != nil {
		return errors.New("encode Prime result start")
	}
	if err := WriteFrame(writer, FrameResultStart, startPayload); err != nil {
		return err
	}
	for _, entry := range export.Entries {
		entryPayload, err := json.Marshal(entry)
		if err != nil {
			return fmt.Errorf("encode Prime result entry %q: %w", entry.Path, err)
		}
		if err := WriteFrame(writer, FrameResultEntry, entryPayload); err != nil {
			return err
		}
		if entry.Type != EntryFile {
			continue
		}
		if err := writeResultFile(root, writer, entry); err != nil {
			return err
		}
		if err := WriteFrame(writer, FrameResultFileEnd, nil); err != nil {
			return err
		}
	}
	return WriteFrame(writer, FrameResultComplete, nil)
}

func captureDirectory(
	root *os.Root,
	directoryPath string,
	entries *[]ManifestEntry,
	totalBytes *int64,
) error {
	directory, err := root.Open(directoryPath)
	if err != nil {
		return fmt.Errorf("open Prime result directory %q: %w", directoryPath, err)
	}
	children, readError := directory.Readdir(-1)
	closeError := directory.Close()
	if readError != nil {
		return fmt.Errorf("read Prime result directory %q: %w", directoryPath, readError)
	}
	if closeError != nil {
		return fmt.Errorf("close Prime result directory %q: %w", directoryPath, closeError)
	}
	sort.Slice(children, func(left int, right int) bool {
		return bytes.Compare([]byte(children[left].Name()), []byte(children[right].Name())) < 0
	})
	for _, child := range children {
		childPath := child.Name()
		if directoryPath != "." {
			childPath = path.Join(directoryPath, child.Name())
		}
		information, err := root.Lstat(childPath)
		if err != nil {
			return fmt.Errorf("inspect Prime result entry %q: %w", childPath, err)
		}
		if directoryPath == "." && child.Name() == ".flow-prime" {
			if !information.IsDir() {
				return errors.New("Prime reserved control path changed type")
			}
			continue
		}
		if len(*entries) >= MaxEntries {
			return errors.New("Prime result has too many entries")
		}
		if information.IsDir() {
			*entries = append(*entries, ManifestEntry{
				Path: childPath,
				Type: EntryDirectory,
				Mode: int(information.Mode().Perm()),
			})
			if err := captureDirectory(root, childPath, entries, totalBytes); err != nil {
				return err
			}
			continue
		}
		if !information.Mode().IsRegular() {
			return fmt.Errorf("Prime result entry %q is not a regular file or directory", childPath)
		}
		entry, err := captureFile(root, childPath, information)
		if err != nil {
			return err
		}
		*totalBytes += entry.Size
		if *totalBytes > MaxTransferBytes {
			return errors.New("Prime result exceeds the total byte limit")
		}
		*entries = append(*entries, entry)
	}
	return nil
}

func captureFile(root *os.Root, filePath string, observed os.FileInfo) (ManifestEntry, error) {
	if observed.Size() < 0 || observed.Size() > MaxFileBytes {
		return ManifestEntry{}, fmt.Errorf("Prime result file %q exceeds the byte limit", filePath)
	}
	file, err := root.Open(filePath)
	if err != nil {
		return ManifestEntry{}, fmt.Errorf("open Prime result file %q: %w", filePath, err)
	}
	hash := sha256.New()
	read, readError := io.Copy(hash, io.LimitReader(file, MaxFileBytes+1))
	final, statError := file.Stat()
	closeError := file.Close()
	if readError != nil {
		return ManifestEntry{}, fmt.Errorf("hash Prime result file %q: %w", filePath, readError)
	}
	if statError != nil || !final.Mode().IsRegular() || !os.SameFile(observed, final) {
		return ManifestEntry{}, fmt.Errorf("Prime result file %q changed during capture", filePath)
	}
	if closeError != nil {
		return ManifestEntry{}, fmt.Errorf("close Prime result file %q: %w", filePath, closeError)
	}
	if read != observed.Size() || read > MaxFileBytes {
		return ManifestEntry{}, fmt.Errorf("Prime result file %q changed size during capture", filePath)
	}
	return ManifestEntry{
		Path:   filePath,
		Type:   EntryFile,
		Mode:   int(observed.Mode().Perm()),
		Size:   read,
		SHA256: hex.EncodeToString(hash.Sum(nil)),
	}, nil
}

func writeResultFile(root *os.Root, writer io.Writer, entry ManifestEntry) error {
	file, err := root.Open(entry.Path)
	if err != nil {
		return fmt.Errorf("open Prime result file %q for transfer: %w", entry.Path, err)
	}
	defer file.Close()
	hash := sha256.New()
	buffer := make([]byte, MaxFileChunkBytes)
	written := int64(0)
	for {
		read, readError := file.Read(buffer)
		if read > 0 {
			written += int64(read)
			if written > entry.Size || written > MaxFileBytes {
				return fmt.Errorf("Prime result file %q changed size before transfer", entry.Path)
			}
			_, _ = hash.Write(buffer[:read])
			if err := WriteFrame(writer, FrameResultChunk, buffer[:read]); err != nil {
				return err
			}
		}
		if errors.Is(readError, io.EOF) {
			break
		}
		if readError != nil {
			return fmt.Errorf("read Prime result file %q: %w", entry.Path, readError)
		}
	}
	information, err := file.Stat()
	if err != nil || !information.Mode().IsRegular() || int(information.Mode().Perm()) != entry.Mode {
		return fmt.Errorf("Prime result file %q changed metadata before transfer", entry.Path)
	}
	if written != entry.Size || hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
		return fmt.Errorf("Prime result file %q changed content before transfer", entry.Path)
	}
	return nil
}
