package containerprotocol

import (
	"errors"
	"fmt"
	"io"
	"os"
)

type WorkspaceOwnership struct {
	EntryUID int
	EntryGID int
	RootUID  int
	RootGID  int
	RootMode os.FileMode
}

type WorkspaceImporter struct {
	root        *os.Root
	rootFile    *os.File
	validator   *TransferValidator
	ownership   WorkspaceOwnership
	directories []ManifestEntry
	currentFile *os.File
	closed      bool
}

func NewWorkspaceImporter(
	rootPath string,
	start TransferStart,
	ownership WorkspaceOwnership,
) (*WorkspaceImporter, error) {
	if ownership.EntryUID < 0 || ownership.EntryGID < 0 || ownership.RootUID < 0 || ownership.RootGID < 0 {
		return nil, errors.New("Prime workspace ownership contains a negative identity")
	}
	if ownership.RootMode < 0 || ownership.RootMode > 0777 {
		return nil, errors.New("Prime workspace root mode is invalid")
	}
	validator, err := NewTransferValidator(start)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, fmt.Errorf("open Prime workspace root: %w", err)
	}
	rootFile, err := os.Open(rootPath)
	if err != nil {
		root.Close()
		return nil, fmt.Errorf("open Prime workspace root descriptor: %w", err)
	}
	information, err := rootFile.Stat()
	if err != nil || !information.IsDir() {
		rootFile.Close()
		root.Close()
		return nil, errors.New("Prime workspace root is not one directory")
	}
	return &WorkspaceImporter{
		root:        root,
		rootFile:    rootFile,
		validator:   validator,
		ownership:   ownership,
		directories: make([]ManifestEntry, 0, start.EntryCount),
	}, nil
}

func (importer *WorkspaceImporter) AddEntry(entry ManifestEntry) error {
	if err := importer.assertOpen(); err != nil {
		return err
	}
	if err := importer.validator.AddEntry(entry); err != nil {
		return err
	}
	switch entry.Type {
	case EntryDirectory:
		if err := importer.root.Mkdir(entry.Path, 0700); err != nil {
			return fmt.Errorf("create Prime fixture directory %q: %w", entry.Path, err)
		}
		importer.directories = append(importer.directories, entry)
	case EntryFile:
		file, err := importer.root.OpenFile(entry.Path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return fmt.Errorf("create Prime fixture file %q: %w", entry.Path, err)
		}
		importer.currentFile = file
	default:
		return errors.New("Prime fixture entry type is invalid")
	}
	return nil
}

func (importer *WorkspaceImporter) AddChunk(chunk []byte) error {
	if err := importer.assertOpen(); err != nil {
		return err
	}
	if importer.currentFile == nil {
		return errors.New("Prime fixture chunk has no open file")
	}
	if err := importer.validator.AddChunk(chunk); err != nil {
		return err
	}
	for len(chunk) > 0 {
		written, err := importer.currentFile.Write(chunk)
		if err != nil {
			return fmt.Errorf("write Prime fixture file: %w", err)
		}
		if written < 1 {
			return io.ErrShortWrite
		}
		chunk = chunk[written:]
	}
	return nil
}

func (importer *WorkspaceImporter) EndFile() error {
	if err := importer.assertOpen(); err != nil {
		return err
	}
	file := importer.currentFile
	if file == nil {
		return errors.New("Prime fixture file end has no open file")
	}
	if err := importer.validator.EndFile(); err != nil {
		file.Close()
		importer.currentFile = nil
		return err
	}
	entry := importer.validator.entries[len(importer.validator.entries)-1]
	if err := file.Sync(); err != nil {
		return fmt.Errorf("synchronize Prime fixture file %q: %w", entry.Path, err)
	}
	if err := file.Chown(importer.ownership.EntryUID, importer.ownership.EntryGID); err != nil {
		return fmt.Errorf("set Prime fixture file ownership %q: %w", entry.Path, err)
	}
	if err := file.Chmod(os.FileMode(entry.Mode)); err != nil {
		return fmt.Errorf("set Prime fixture file mode %q: %w", entry.Path, err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("synchronize Prime fixture file metadata %q: %w", entry.Path, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close Prime fixture file %q: %w", entry.Path, err)
	}
	importer.currentFile = nil
	return nil
}

func (importer *WorkspaceImporter) Complete() ([]ManifestEntry, error) {
	if err := importer.assertOpen(); err != nil {
		return nil, err
	}
	entries, err := importer.validator.Complete()
	if err != nil {
		return nil, err
	}
	for index := len(importer.directories) - 1; index >= 0; index-- {
		entry := importer.directories[index]
		directory, err := importer.root.Open(entry.Path)
		if err != nil {
			return nil, fmt.Errorf("open Prime fixture directory %q: %w", entry.Path, err)
		}
		if err := settleDirectory(directory, entry, importer.ownership); err != nil {
			directory.Close()
			return nil, err
		}
		if err := directory.Close(); err != nil {
			return nil, fmt.Errorf("close Prime fixture directory %q: %w", entry.Path, err)
		}
	}
	if err := importer.rootFile.Chown(importer.ownership.RootUID, importer.ownership.RootGID); err != nil {
		return nil, fmt.Errorf("set Prime workspace root ownership: %w", err)
	}
	if err := importer.rootFile.Chmod(importer.ownership.RootMode); err != nil {
		return nil, fmt.Errorf("set Prime workspace root mode: %w", err)
	}
	if err := importer.rootFile.Sync(); err != nil {
		return nil, fmt.Errorf("synchronize Prime workspace root: %w", err)
	}
	return entries, nil
}

func (importer *WorkspaceImporter) Close() error {
	if importer.closed {
		return nil
	}
	importer.closed = true
	var result error
	if importer.currentFile != nil {
		result = errors.Join(result, importer.currentFile.Close())
		importer.currentFile = nil
	}
	result = errors.Join(result, importer.rootFile.Close())
	result = errors.Join(result, importer.root.Close())
	return result
}

func (importer *WorkspaceImporter) assertOpen() error {
	if importer.closed {
		return errors.New("Prime workspace importer is closed")
	}
	return nil
}

func settleDirectory(
	directory *os.File,
	entry ManifestEntry,
	ownership WorkspaceOwnership,
) error {
	information, err := directory.Stat()
	if err != nil || !information.IsDir() {
		return fmt.Errorf("Prime fixture directory %q changed type", entry.Path)
	}
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("synchronize Prime fixture directory %q: %w", entry.Path, err)
	}
	if err := directory.Chown(ownership.EntryUID, ownership.EntryGID); err != nil {
		return fmt.Errorf("set Prime fixture directory ownership %q: %w", entry.Path, err)
	}
	if err := directory.Chmod(os.FileMode(entry.Mode)); err != nil {
		return fmt.Errorf("set Prime fixture directory mode %q: %w", entry.Path, err)
	}
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("synchronize Prime fixture directory metadata %q: %w", entry.Path, err)
	}
	return nil
}
