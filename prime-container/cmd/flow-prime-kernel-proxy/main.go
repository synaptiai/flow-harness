package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
)

const supervisorSocket = "/workspace/.flow-prime/control/kernel.sock"

type kernelConnectionFile interface {
	Stat() (os.FileInfo, error)
	Chown(int, int) error
	Chmod(os.FileMode) error
	Close() error
}

type kernelConnectionFilesystem struct {
	open func(string, int, os.FileMode) (kernelConnectionFile, error)
}

func main() {
	request, err := kernelcontract.RequestFromArgs(os.Args[1:])
	if err != nil {
		fail(err)
	}
	if err := admitKernelConnection(request.ConnectionPath); err != nil {
		fail(fmt.Errorf("prepare fixed Python kernel connection: %w", err))
	}
	connection, err := net.Dial("unix", supervisorSocket)
	if err != nil {
		fail(fmt.Errorf("connect to the kernel supervisor: %w", err))
	}
	defer connection.Close()
	if err := writeMessage(connection, request); err != nil {
		fail(err)
	}
	var response kernelcontract.Response
	if err := readMessage(connection, &response); err != nil {
		fail(err)
	}
	if response.Version != 1 || response.ExitCode < 0 || response.ExitCode > 255 {
		fail(errors.New("kernel supervisor response violates the fixed contract"))
	}
	if response.Error != "" {
		fmt.Fprintln(os.Stderr, response.Error)
	}
	os.Exit(response.ExitCode)
}

func admitKernelConnection(path string) error {
	return admitKernelConnectionWith(path, kernelConnectionFilesystem{
		open: func(path string, flags int, mode os.FileMode) (kernelConnectionFile, error) {
			return os.OpenFile(path, flags, mode)
		},
	})
}

func admitKernelConnectionWith(path string, filesystem kernelConnectionFilesystem) error {
	if !kernelcontract.IsProvisionerConnectionPath(path) {
		return errors.New("kernel connection path does not match the fixed contract")
	}
	file, err := filesystem.open(path, os.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open fixed kernel connection file: %w", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = file.Close()
		}
	}()
	information, err := file.Stat()
	if err != nil {
		return fmt.Errorf("inspect fixed kernel connection file: %w", err)
	}
	stat, ok := information.Sys().(*syscall.Stat_t)
	if !ok || !information.Mode().IsRegular() || stat.Uid != kernelcontract.NodeUID ||
		stat.Gid != kernelcontract.NodeUID || information.Mode().Perm() != 0600 ||
		information.Size() < 1 || information.Size() > kernelcontract.MaxMessageBytes {
		return errors.New("kernel connection file violates the fixed proxy identity")
	}
	if err := file.Chown(-1, kernelcontract.SharedGID); err != nil {
		return fmt.Errorf("set fixed kernel connection group: %w", err)
	}
	if err := file.Chmod(0660); err != nil {
		return fmt.Errorf("set fixed kernel connection mode: %w", err)
	}
	closeError := file.Close()
	closed = true
	if closeError != nil {
		return fmt.Errorf("close fixed kernel connection file: %w", closeError)
	}
	return nil
}

func writeMessage(writer io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil || len(payload) > kernelcontract.MaxMessageBytes {
		return errors.New("kernel request cannot be encoded")
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))
	if _, err := writer.Write(append(header, payload...)); err != nil {
		return fmt.Errorf("write kernel request: %w", err)
	}
	return nil
}

func readMessage(reader io.Reader, value any) error {
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil {
		return fmt.Errorf("read kernel response header: %w", err)
	}
	length := binary.BigEndian.Uint32(header)
	if length == 0 || length > kernelcontract.MaxMessageBytes {
		return errors.New("kernel response exceeds its byte limit")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return fmt.Errorf("read kernel response: %w", err)
	}
	if err := json.Unmarshal(payload, value); err != nil {
		return errors.New("kernel response is not valid JSON")
	}
	return nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(125)
}
