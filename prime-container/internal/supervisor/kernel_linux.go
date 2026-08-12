//go:build linux

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
)

const (
	pythonLauncher                 = "/opt/flow/bin/flow-prime-python"
	maxStderrBytes                 = 65536
	kernelConnectionResolveTimeout = 4500 * time.Millisecond
	kernelConnectionPollInterval   = 10 * time.Millisecond
)

func PeerUID(connection *net.UnixConn) (int, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return 0, fmt.Errorf("access kernel peer socket: %w", err)
	}
	var credential *syscall.Ucred
	var socketError error
	if err := raw.Control(func(fd uintptr) {
		credential, socketError = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return 0, fmt.Errorf("inspect kernel peer socket: %w", err)
	}
	if socketError != nil || credential == nil {
		return 0, fmt.Errorf("inspect kernel peer identity: %w", socketError)
	}
	return int(credential.Uid), nil
}

func RunKernel(ctx context.Context, request kernelcontract.Request) (int, string) {
	file, initialConnection, err := openKernelConnectionFile(request.ConnectionPath)
	if err != nil {
		return 125, boundedError("inspect fixed kernel connection file", err)
	}
	defer cleanupKernelConnection(file, request.ConnectionPath)
	if err := preparePythonKernelConnection(initialConnection); err != nil {
		return 125, boundedError("prepare fixed Python kernel connection", err)
	}
	defer os.Remove(kernelcontract.PythonConnectionPath)

	command := exec.Command(
		pythonLauncher,
		"-m",
		"ipykernel_launcher",
		"-f",
		kernelcontract.PythonConnectionPath,
	)
	command.Dir = "/workspace"
	command.Env = []string{
		"HOME=/workspace/.flow-prime/home",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"PATH=/opt/flow/bin:/opt/flow/python/bin:/usr/bin:/bin",
		"PRIME_AGENT_KERNEL_FORKSERVER=0",
		"TMPDIR=/workspace/.flow-prime/tmp",
	}
	command.Stdin = nil
	command.Stdout = nil
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
		Credential: &syscall.Credential{
			Uid:    PythonUID,
			Gid:    PythonUID,
			Groups: []uint32{SharedGID},
		},
	}
	standardError, err := command.StderrPipe()
	if err != nil {
		return 125, boundedError("create kernel diagnostic pipe", err)
	}
	if err := command.Start(); err != nil {
		return 125, boundedError("start fixed Python kernel", err)
	}
	type diagnosticResult struct {
		value    []byte
		overflow bool
		err      error
	}
	diagnostic := make(chan diagnosticResult, 1)
	go func() {
		value, readError := io.ReadAll(io.LimitReader(standardError, maxStderrBytes+1))
		overflow := len(value) > maxStderrBytes
		if overflow {
			value = value[:maxStderrBytes]
			_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		}
		diagnostic <- diagnosticResult{value: value, overflow: overflow, err: readError}
	}()
	processSettlement := make(chan error, 1)
	go func() {
		processSettlement <- command.Wait()
	}()
	if err := bridgeResolvedKernelConnection(ctx, file, initialConnection); err != nil {
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		<-processSettlement
		<-diagnostic
		if ctx.Err() != nil {
			return 0, ""
		}
		return 125, boundedError("resolve fixed Python kernel connection", err)
	}
	waitError, cancelled := waitForKernelSettlement(
		ctx,
		processSettlement,
		func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGKILL) },
	)
	diagnosticValue := <-diagnostic
	if cancelled {
		return 0, ""
	}
	if diagnosticValue.err != nil {
		return 125, boundedError("read kernel standard error", diagnosticValue.err)
	}
	if diagnosticValue.overflow {
		return 125, "kernel standard error exceeds 65536 bytes"
	}
	if waitError == nil {
		return 0, ""
	} else {
		var exitError *exec.ExitError
		if errors.As(waitError, &exitError) && exitError.ExitCode() >= 0 && exitError.ExitCode() <= 255 {
			return exitError.ExitCode(), boundedText(string(diagnosticValue.value))
		}
		return 125, boundedError("run fixed Python kernel", waitError)
	}
}

func openKernelConnectionFile(path string) (*os.File, kernelConnectionInformation, error) {
	if !kernelcontract.IsProvisionerConnectionPath(path) {
		return nil, kernelConnectionInformation{}, errors.New("kernel connection path violates the fixed contract")
	}
	rootDescriptor, err := syscall.Open(
		kernelcontract.ConnectionRoot,
		syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return nil, kernelConnectionInformation{}, fmt.Errorf("open fixed kernel connection root: %w", err)
	}
	defer syscall.Close(rootDescriptor)

	directoryName := filepath.Base(filepath.Dir(path))
	directoryDescriptor, err := syscall.Openat(
		rootDescriptor,
		directoryName,
		syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return nil, kernelConnectionInformation{}, fmt.Errorf("open fixed kernel connection directory: %w", err)
	}
	defer syscall.Close(directoryDescriptor)
	if err := validateKernelConnectionDirectory(directoryDescriptor); err != nil {
		return nil, kernelConnectionInformation{}, err
	}

	fileDescriptor, err := syscall.Openat(
		directoryDescriptor,
		kernelcontract.ConnectionFileName,
		syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return nil, kernelConnectionInformation{}, fmt.Errorf("open fixed kernel connection file: %w", err)
	}
	file := os.NewFile(uintptr(fileDescriptor), path)
	if file == nil {
		syscall.Close(fileDescriptor)
		return nil, kernelConnectionInformation{}, errors.New("open fixed kernel connection file descriptor")
	}
	valid := false
	defer func() {
		if !valid {
			file.Close()
		}
	}()
	initial, err := validateKernelConnectionFile(file)
	if err != nil {
		return nil, kernelConnectionInformation{}, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, kernelConnectionInformation{}, fmt.Errorf("rewind kernel connection file: %w", err)
	}
	valid = true
	return file, initial, nil
}

func validateKernelConnectionDirectory(descriptor int) error {
	var information syscall.Stat_t
	if err := syscall.Fstat(descriptor, &information); err != nil {
		return fmt.Errorf("inspect kernel connection directory: %w", err)
	}
	if information.Mode&syscall.S_IFMT != syscall.S_IFDIR ||
		information.Uid != NodeUID || information.Gid != NodeUID ||
		information.Mode&0777 != 0700 {
		return errors.New("kernel connection directory violates the fixed identity")
	}
	return nil
}

func validateKernelConnectionFile(file *os.File) (kernelConnectionInformation, error) {
	information, err := file.Stat()
	if err != nil {
		return kernelConnectionInformation{}, fmt.Errorf("inspect kernel connection file: %w", err)
	}
	stat, ok := information.Sys().(*syscall.Stat_t)
	if !ok || !information.Mode().IsRegular() || stat.Uid != NodeUID || stat.Gid != NodeUID ||
		information.Mode().Perm() != 0600 || information.Size() < 1 ||
		information.Size() > kernelcontract.MaxMessageBytes {
		return kernelConnectionInformation{}, errors.New("kernel connection file violates the fixed identity")
	}
	value, err := io.ReadAll(io.LimitReader(file, kernelcontract.MaxMessageBytes+1))
	if err != nil {
		return kernelConnectionInformation{}, fmt.Errorf("read kernel connection file: %w", err)
	}
	if len(value) > kernelcontract.MaxMessageBytes {
		return kernelConnectionInformation{}, errors.New("kernel connection file exceeds its byte limit")
	}
	return parseInitialKernelConnection(value)
}

func preparePythonKernelConnection(connection kernelConnectionInformation) error {
	value, err := json.Marshal(connection)
	if err != nil {
		return errors.New("encode fixed Python kernel connection")
	}
	file, err := os.OpenFile(
		kernelcontract.PythonConnectionPath,
		os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW,
		0600,
	)
	if err != nil {
		return fmt.Errorf("create fixed Python kernel connection: %w", err)
	}
	defer file.Close()
	if err := file.Chown(PythonUID, PythonUID); err != nil {
		return fmt.Errorf("set fixed Python kernel connection owner: %w", err)
	}
	if _, err := file.Write(value); err != nil {
		return fmt.Errorf("write fixed Python kernel connection: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("synchronize fixed Python kernel connection: %w", err)
	}
	return nil
}

func bridgeResolvedKernelConnection(
	ctx context.Context,
	nodeFile *os.File,
	initial kernelConnectionInformation,
) error {
	deadline := time.NewTimer(kernelConnectionResolveTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(kernelConnectionPollInterval)
	defer ticker.Stop()
	for {
		resolved, err := readResolvedPythonKernelConnection(initial)
		if err == nil {
			if err := nodeFile.Truncate(0); err != nil {
				return fmt.Errorf("truncate Node kernel connection: %w", err)
			}
			if _, err := nodeFile.Seek(0, io.SeekStart); err != nil {
				return fmt.Errorf("rewind Node kernel connection: %w", err)
			}
			if _, err := nodeFile.Write(resolved); err != nil {
				return fmt.Errorf("write resolved Node kernel connection: %w", err)
			}
			if err := nodeFile.Sync(); err != nil {
				return fmt.Errorf("synchronize resolved Node kernel connection: %w", err)
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("Python kernel connection did not resolve within its fixed deadline")
		case <-ticker.C:
		}
	}
}

func readResolvedPythonKernelConnection(initial kernelConnectionInformation) ([]byte, error) {
	file, err := os.OpenFile(
		kernelcontract.PythonConnectionPath,
		os.O_RDONLY|syscall.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	information, err := file.Stat()
	if err != nil {
		return nil, err
	}
	stat, ok := information.Sys().(*syscall.Stat_t)
	if !ok || !information.Mode().IsRegular() || stat.Uid != PythonUID || stat.Gid != PythonUID ||
		information.Mode().Perm() != 0600 || information.Size() < 1 ||
		information.Size() > kernelcontract.MaxMessageBytes {
		return nil, errors.New("Python kernel connection violates the fixed identity")
	}
	value, err := io.ReadAll(io.LimitReader(file, kernelcontract.MaxMessageBytes+1))
	if err != nil {
		return nil, err
	}
	return parseResolvedKernelConnection(value, initial)
}

func boundedError(label string, err error) string {
	return boundedText(fmt.Sprintf("%s: %v", label, err))
}

func boundedText(value string) string {
	if len(value) <= 4096 {
		return value
	}
	return value[:4096]
}
