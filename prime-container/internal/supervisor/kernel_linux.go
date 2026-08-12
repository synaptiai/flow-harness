//go:build linux

package supervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"syscall"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
)

const (
	pythonLauncher = "/opt/flow/bin/flow-prime-python"
	maxStderrBytes = 65536
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
	file, err := os.OpenFile(request.ConnectionPath, os.O_RDWR|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return 125, boundedError("open fixed kernel connection file", err)
	}
	information, err := file.Stat()
	if err != nil || !information.Mode().IsRegular() {
		file.Close()
		return 125, "fixed kernel connection file is not one regular file"
	}
	if err := file.Chown(NodeUID, SharedGID); err != nil {
		file.Close()
		return 125, boundedError("set kernel connection file group", err)
	}
	if err := file.Chmod(0660); err != nil {
		file.Close()
		return 125, boundedError("set kernel connection file mode", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return 125, boundedError("synchronize kernel connection file", err)
	}
	if err := file.Close(); err != nil {
		return 125, boundedError("close kernel connection file", err)
	}
	defer os.Remove(request.ConnectionPath)

	command := exec.Command(
		pythonLauncher,
		"-m",
		"ipykernel_launcher",
		"-f",
		kernelcontract.ConnectionPath,
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

func boundedError(label string, err error) string {
	return boundedText(fmt.Sprintf("%s: %v", label, err))
}

func boundedText(value string) string {
	if len(value) <= 4096 {
		return value
	}
	return value[:4096]
}
