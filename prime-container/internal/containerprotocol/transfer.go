package containerprotocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"strings"
)

type TransferStart struct {
	EntryCount     int    `json:"entryCount"`
	TotalBytes     int64  `json:"totalBytes"`
	ManifestSHA256 string `json:"manifestSha256"`
}

type activeFile struct {
	entry ManifestEntry
	hash  hash.Hash
	bytes int64
}

type TransferValidator struct {
	expected      TransferStart
	entries       []ManifestEntry
	entryTypes    map[string]EntryType
	currentFile   *activeFile
	declaredBytes int64
	receivedBytes int64
	chunkFrames   int
	complete      bool
}

func ParseTransferStart(source []byte) (TransferStart, error) {
	var start TransferStart
	if err := decodeStrictJSON(source, &start); err != nil {
		return TransferStart{}, fmt.Errorf("parse Prime transfer start: %w", err)
	}
	if err := validateTransferStart(start); err != nil {
		return TransferStart{}, err
	}
	return start, nil
}

func NewTransferValidator(expected TransferStart) (*TransferValidator, error) {
	if err := validateTransferStart(expected); err != nil {
		return nil, err
	}
	return &TransferValidator{
		expected:   expected,
		entries:    make([]ManifestEntry, 0, expected.EntryCount),
		entryTypes: make(map[string]EntryType, expected.EntryCount),
	}, nil
}

func (validator *TransferValidator) AddEntry(entry ManifestEntry) error {
	if err := validator.assertActive(); err != nil {
		return err
	}
	if validator.currentFile != nil {
		return errors.New("Prime container file must end before the next entry")
	}
	if len(validator.entries) >= validator.expected.EntryCount {
		return errors.New("Prime container transfer has too many entries")
	}
	if err := validateManifestEntry(entry); err != nil {
		return err
	}
	if len(validator.entries) > 0 {
		previous := validator.entries[len(validator.entries)-1]
		if bytes.Compare([]byte(previous.Path), []byte(entry.Path)) >= 0 {
			return errors.New("Prime container manifest contains a duplicate or out-of-order path")
		}
	}
	if err := validator.validateParents(entry.Path); err != nil {
		return err
	}
	if entry.Type == EntryFile {
		validator.declaredBytes += entry.Size
		if validator.declaredBytes > validator.expected.TotalBytes || validator.declaredBytes > MaxTransferBytes {
			return errors.New("Prime container manifest exceeds the total file size")
		}
		validator.currentFile = &activeFile{entry: entry, hash: sha256.New()}
	}
	validator.entries = append(validator.entries, entry)
	validator.entryTypes[entry.Path] = entry.Type
	return nil
}

func (validator *TransferValidator) AddChunk(chunk []byte) error {
	if err := validator.assertActive(); err != nil {
		return err
	}
	current := validator.currentFile
	if current == nil {
		return errors.New("Prime container file chunk has no active file entry")
	}
	if len(chunk) < 1 || len(chunk) > MaxFileChunkBytes {
		return errors.New("Prime container file chunk exceeds the byte limit")
	}
	validator.chunkFrames++
	if validator.chunkFrames > MaxChunkFrames {
		return errors.New("Prime container transfer exceeds the chunk-frame limit")
	}
	current.bytes += int64(len(chunk))
	validator.receivedBytes += int64(len(chunk))
	if current.bytes > current.entry.Size {
		return errors.New("Prime container file data exceeds its declared size")
	}
	if validator.receivedBytes > validator.expected.TotalBytes || validator.receivedBytes > MaxTransferBytes {
		return errors.New("Prime container transfer exceeds its declared byte count")
	}
	_, _ = current.hash.Write(chunk)
	return nil
}

func (validator *TransferValidator) EndFile() error {
	if err := validator.assertActive(); err != nil {
		return err
	}
	current := validator.currentFile
	if current == nil {
		return errors.New("Prime container file end has no active file entry")
	}
	if current.bytes != current.entry.Size {
		return errors.New("Prime container file size does not match its manifest entry")
	}
	if hex.EncodeToString(current.hash.Sum(nil)) != current.entry.SHA256 {
		return errors.New("Prime container file SHA-256 does not match its manifest entry")
	}
	validator.currentFile = nil
	return nil
}

func (validator *TransferValidator) Complete() ([]ManifestEntry, error) {
	if err := validator.assertActive(); err != nil {
		return nil, err
	}
	if validator.currentFile != nil {
		return nil, errors.New("Prime container transfer ends before the active file end marker")
	}
	if len(validator.entries) != validator.expected.EntryCount {
		return nil, errors.New("Prime container transfer entry count does not match its manifest")
	}
	if validator.declaredBytes != validator.expected.TotalBytes || validator.receivedBytes != validator.expected.TotalBytes {
		return nil, errors.New("Prime container transfer byte count does not match its manifest")
	}
	digest, err := ManifestSHA256(validator.entries)
	if err != nil {
		return nil, err
	}
	if digest != validator.expected.ManifestSHA256 {
		return nil, errors.New("Prime container manifest SHA-256 does not match its entries")
	}
	validator.complete = true
	return append([]ManifestEntry(nil), validator.entries...), nil
}

func (validator *TransferValidator) validateParents(path string) error {
	components := strings.Split(path, "/")
	for index := 1; index < len(components); index++ {
		parent := strings.Join(components[:index], "/")
		entryType, found := validator.entryTypes[parent]
		if !found {
			return fmt.Errorf("Prime container manifest is missing parent directory: %s", parent)
		}
		if entryType != EntryDirectory {
			return fmt.Errorf("Prime container manifest has a file path prefix: %s", parent)
		}
	}
	return nil
}

func (validator *TransferValidator) assertActive() error {
	if validator.complete {
		return errors.New("Prime container transfer is already complete")
	}
	return nil
}

func validateTransferStart(start TransferStart) error {
	if start.EntryCount < 0 || start.EntryCount > MaxEntries {
		return errors.New("Prime container transfer entry count exceeds the limit")
	}
	if start.TotalBytes < 0 || start.TotalBytes > MaxTransferBytes {
		return errors.New("Prime container transfer total bytes exceeds the limit")
	}
	if !sha256Pattern.MatchString(start.ManifestSHA256) {
		return errors.New("Prime container transfer manifest SHA-256 is invalid")
	}
	return nil
}
