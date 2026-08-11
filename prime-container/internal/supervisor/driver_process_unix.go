//go:build linux || darwin

package supervisor

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/synaptiai/flow-harness/prime-container/internal/containerprotocol"
)

const driverHardeningProofTimeout = 5 * time.Second

type DriverProcessOptions struct {
	Executable         string
	Arguments          []string
	Environment        []string
	WorkingDirectory   string
	UID                int
	GID                int
	Groups             []int
	MaxDiagnosticBytes int
}

type DriverProcessResult struct {
	ExitCode   int
	Diagnostic string
}

func RunDriverProcess(
	hostReader io.Reader,
	hostWriter io.Writer,
	bootstrap []byte,
	options DriverProcessOptions,
) (DriverProcessResult, error) {
	if options.Executable == "" || options.WorkingDirectory == "" || options.MaxDiagnosticBytes < 1 {
		return DriverProcessResult{}, errors.New("Prime driver process options are incomplete")
	}
	descriptors, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return DriverProcessResult{}, fmt.Errorf("create Prime driver socket: %w", err)
	}
	supervisorSocket := os.NewFile(uintptr(descriptors[0]), "flow-prime-supervisor-driver")
	driverSocket := os.NewFile(uintptr(descriptors[1]), "flow-prime-driver-supervisor")
	if supervisorSocket == nil || driverSocket == nil {
		if supervisorSocket != nil {
			supervisorSocket.Close()
		}
		if driverSocket != nil {
			driverSocket.Close()
		}
		return DriverProcessResult{}, errors.New("create Prime driver socket descriptors")
	}
	defer supervisorSocket.Close()
	defer driverSocket.Close()
	hardeningReader, hardeningWriter, err := os.Pipe()
	if err != nil {
		return DriverProcessResult{}, fmt.Errorf("create Prime driver hardening pipe: %w", err)
	}
	defer hardeningReader.Close()
	defer hardeningWriter.Close()
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return DriverProcessResult{}, fmt.Errorf("open null device for Prime driver: %w", err)
	}
	defer null.Close()
	command := exec.Command(options.Executable, options.Arguments...)
	command.Dir = options.WorkingDirectory
	command.Env = append([]string(nil), options.Environment...)
	command.Stdin = null
	command.Stdout = null
	command.ExtraFiles = []*os.File{driverSocket, hardeningWriter}
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if options.UID >= 0 || options.GID >= 0 {
		if options.UID < 0 || options.GID < 0 {
			return DriverProcessResult{}, errors.New("Prime driver user and group must be set together")
		}
		groups := make([]uint32, len(options.Groups))
		for index, group := range options.Groups {
			if group < 0 {
				return DriverProcessResult{}, errors.New("Prime driver supplemental group is negative")
			}
			groups[index] = uint32(group)
		}
		command.SysProcAttr.Credential = &syscall.Credential{
			Uid: uint32(options.UID), Gid: uint32(options.GID), Groups: groups,
		}
	}
	standardError, err := command.StderrPipe()
	if err != nil {
		return DriverProcessResult{}, fmt.Errorf("create Prime driver diagnostic pipe: %w", err)
	}
	if err := command.Start(); err != nil {
		return DriverProcessResult{}, fmt.Errorf("start Prime driver: %w", err)
	}
	type diagnosticResult struct {
		value    []byte
		overflow bool
		err      error
	}
	diagnostic := make(chan diagnosticResult, 1)
	go func() {
		value, readError := io.ReadAll(io.LimitReader(standardError, int64(options.MaxDiagnosticBytes)+1))
		diagnostic <- diagnosticResult{
			value: value, overflow: len(value) > options.MaxDiagnosticBytes, err: readError,
		}
	}()
	if err := driverSocket.Close(); err != nil {
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		<-diagnostic
		_ = command.Wait()
		return DriverProcessResult{}, fmt.Errorf("close parent copy of Prime driver socket: %w", err)
	}
	if err := hardeningWriter.Close(); err != nil {
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		<-diagnostic
		_ = command.Wait()
		return DriverProcessResult{}, fmt.Errorf("close parent copy of Prime hardening pipe: %w", err)
	}
	hardeningProof := make(chan error, 1)
	go func() {
		value, readError := io.ReadAll(io.LimitReader(hardeningReader, 2))
		if readError != nil {
			hardeningProof <- readError
			return
		}
		if len(value) != 1 || value[0] != 1 {
			hardeningProof <- errors.New("Prime driver hardening proof is invalid")
			return
		}
		hardeningProof <- nil
	}()
	select {
	case proofError := <-hardeningProof:
		if proofError != nil {
			_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
			<-diagnostic
			_ = command.Wait()
			return DriverProcessResult{}, proofError
		}
	case <-time.After(driverHardeningProofTimeout):
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		<-diagnostic
		_ = command.Wait()
		return DriverProcessResult{}, errors.New("Prime driver hardening proof timed out")
	}
	relayError := containerprotocol.RelayDriver(hostReader, hostWriter, supervisorSocket, bootstrap)
	if relayError != nil {
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	}
	diagnosticValue := <-diagnostic
	waitError := command.Wait()
	if diagnosticValue.err != nil {
		return DriverProcessResult{}, fmt.Errorf("read Prime driver diagnostic: %w", diagnosticValue.err)
	}
	if diagnosticValue.overflow {
		return DriverProcessResult{}, fmt.Errorf(
			"Prime driver diagnostic exceeds %d bytes",
			options.MaxDiagnosticBytes,
		)
	}
	exitCode := command.ProcessState.ExitCode()
	result := DriverProcessResult{ExitCode: exitCode, Diagnostic: boundedDiagnostic(diagnosticValue.value)}
	if relayError != nil {
		return result, relayError
	}
	if waitError != nil || exitCode != 0 {
		return result, fmt.Errorf("Prime driver exited with code %d", exitCode)
	}
	return result, nil
}

func boundedDiagnostic(value []byte) string {
	return string(value)
}
