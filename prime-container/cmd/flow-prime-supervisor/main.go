package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"github.com/synaptiai/flow-harness/prime-container/internal/containerprotocol"
	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
	"github.com/synaptiai/flow-harness/prime-container/internal/supervisor"
)

const (
	kernelSocket  = "/workspace/.flow-prime/control/kernel.sock"
	nodePath      = "/usr/local/bin/node"
	driverPath    = "/opt/flow/node/flow-dist/infrastructure/prime/native-prime-agent-evaluation-driver.js"
	workspacePath = "/workspace"
)

type kernelServiceResult struct {
	requests int
	err      error
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(125)
	}
}

func run() error {
	if os.Geteuid() != 0 {
		return errors.New("Prime supervisor must start as the fixed container supervisor user")
	}
	if err := supervisor.HardenSupervisor(); err != nil {
		return err
	}
	if err := preparePrivatePaths(); err != nil {
		return err
	}
	listener, err := createKernelListener()
	if err != nil {
		return err
	}
	defer listener.Close()
	kernelContext, cancelKernel := context.WithCancel(context.Background())
	defer cancelKernel()
	kernelResults := make(chan kernelServiceResult, 1)
	go func() {
		requests, serveError := serveKernels(kernelContext, listener)
		kernelResults <- kernelServiceResult{requests: requests, err: serveError}
	}()
	prepared, err := containerprotocol.ReceivePreparation(containerprotocol.PreparationInput{
		Reader: os.Stdin, Writer: os.Stdout, WorkspacePath: workspacePath,
		Ownership: containerprotocol.WorkspaceOwnership{
			EntryUID: supervisor.PythonUID, EntryGID: supervisor.PythonUID,
			RootUID: supervisor.PythonUID, RootGID: supervisor.SharedGID, RootMode: 0710,
		},
		Readiness: func(challenge containerprotocol.ReadinessChallenge) ([]byte, error) {
			measurement, err := supervisor.MeasureReadiness(
				challenge.ImageDeviceMajor, challenge.ImageDeviceMinor,
			)
			if err != nil {
				return nil, err
			}
			return supervisor.BuildReadiness(challenge, measurement)
		},
	})
	if err != nil {
		return err
	}
	driverResult, driverError := supervisor.RunDriverProcess(
		os.Stdin,
		os.Stdout,
		prepared.Bootstrap,
		primeDriverProcessOptions(),
	)
	kernelResult, kernelError := settleKernelService(
		cancelKernel,
		listener.Close,
		kernelResults,
		supervisor.TerminatePythonProcesses,
	)
	if kernelError != nil {
		kernelError = fmt.Errorf("settle Prime kernel service: %w", kernelError)
	}
	if driverError != nil {
		driverError = fmt.Errorf("run Prime driver: %w", driverError)
		if kernelError != nil {
			return errors.Join(driverError, kernelError)
		}
		return driverError
	}
	if kernelError != nil {
		return kernelError
	}
	exported, err := containerprotocol.CaptureWorkspace(workspacePath)
	if err != nil {
		return fmt.Errorf("capture Prime workspace: %w", err)
	}
	if err := exported.WriteResultFrames(os.Stdout); err != nil {
		return fmt.Errorf("write Prime result: %w", err)
	}
	settlement, err := json.Marshal(map[string]any{
		"exitCode":         driverResult.ExitCode,
		"timedOut":         false,
		"aborted":          false,
		"activeTimeMicros": nil,
		"kernelRequests":   kernelResult.requests,
	})
	if err != nil {
		return errors.New("encode Prime settlement")
	}
	if err := containerprotocol.WriteFrame(
		os.Stdout,
		containerprotocol.FrameSettlement,
		settlement,
	); err != nil {
		return fmt.Errorf("write Prime settlement: %w", err)
	}
	return nil
}

func settleKernelService(
	cancelKernel func(),
	closeListener func() error,
	results <-chan kernelServiceResult,
	reconcilePython func() error,
) (kernelServiceResult, error) {
	cancelKernel()
	closeError := closeListener()
	result := <-results
	reconcileError := reconcilePython()
	var failures []error
	if closeError != nil && !errors.Is(closeError, net.ErrClosed) {
		failures = append(failures, fmt.Errorf("close kernel supervisor listener: %w", closeError))
	}
	if result.err != nil && !errors.Is(result.err, net.ErrClosed) {
		failures = append(failures, result.err)
	}
	if reconcileError != nil {
		failures = append(failures, reconcileError)
	}
	return result, errors.Join(failures...)
}

func primeDriverProcessOptions() supervisor.DriverProcessOptions {
	return supervisor.DriverProcessOptions{
		Executable: nodePath,
		Arguments:  []string{driverPath},
		Environment: []string{
			"HOME=/run/flow-node", "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
			"LD_PRELOAD=/opt/flow/lib/flow-prime-node-hardening.so",
			"NODE_ENV=production", "PATH=/usr/local/bin:/usr/bin:/bin",
			"FLOW_PRIME_HARDENING_FD=4",
			"PRIME_AGENT_KERNEL_FORKSERVER=0", "TMPDIR=/workspace/.flow-prime/control",
		},
		WorkingDirectory:   workspacePath,
		UID:                supervisor.NodeUID,
		GID:                supervisor.NodeUID,
		Groups:             []int{supervisor.SharedGID},
		MaxDiagnosticBytes: 65536,
	}
}

func preparePrivatePaths() error {
	return preparePrivatePathsWith(privatePathFilesystem{
		mkdirAll: os.MkdirAll,
		chown:    os.Chown,
		chmod:    os.Chmod,
	})
}

type privatePathFilesystem struct {
	mkdirAll func(string, os.FileMode) error
	chown    func(string, int, int) error
	chmod    func(string, os.FileMode) error
}

func preparePrivatePathsWith(filesystem privatePathFilesystem) error {
	paths := []struct {
		path string
		mode os.FileMode
		uid  int
		gid  int
	}{
		{"/run/flow-node", 0700, supervisor.NodeUID, supervisor.NodeUID},
		{"/workspace/.flow-prime", 0710, supervisor.PythonUID, supervisor.SharedGID},
		{"/workspace/.flow-prime/home", 0700, supervisor.PythonUID, supervisor.PythonUID},
		{"/workspace/.flow-prime/tmp", 0700, supervisor.PythonUID, supervisor.PythonUID},
		{"/workspace/.flow-prime/control", 0770, supervisor.NodeUID, supervisor.SharedGID},
	}
	for _, item := range paths {
		if err := filesystem.mkdirAll(item.path, 0700); err != nil {
			return fmt.Errorf("create Prime private path %s: %w", item.path, err)
		}
	}
	for index, item := range paths {
		if index == 1 {
			continue
		}
		if err := settlePrivatePath(filesystem, item.path, item.mode, item.uid, item.gid); err != nil {
			return err
		}
	}
	root := paths[1]
	return settlePrivatePath(filesystem, root.path, root.mode, root.uid, root.gid)
}

func settlePrivatePath(
	filesystem privatePathFilesystem,
	path string,
	mode os.FileMode,
	uid int,
	gid int,
) error {
	if err := filesystem.chown(path, uid, gid); err != nil {
		return fmt.Errorf("set Prime private path owner %s: %w", path, err)
	}
	if err := filesystem.chmod(path, mode); err != nil {
		return fmt.Errorf("set Prime private path mode %s: %w", path, err)
	}
	return nil
}

func createKernelListener() (*net.UnixListener, error) {
	if err := os.MkdirAll(filepath.Dir(kernelSocket), 0700); err != nil {
		return nil, fmt.Errorf("create kernel supervisor directory: %w", err)
	}
	if err := os.Remove(kernelSocket); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("remove stale kernel supervisor socket: %w", err)
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: kernelSocket, Net: "unix"})
	if err != nil {
		return nil, fmt.Errorf("listen on kernel supervisor socket: %w", err)
	}
	if err := os.Chown(kernelSocket, supervisor.NodeUID, supervisor.SharedGID); err != nil {
		listener.Close()
		return nil, fmt.Errorf("set kernel supervisor socket owner: %w", err)
	}
	if err := os.Chmod(kernelSocket, 0660); err != nil {
		listener.Close()
		return nil, fmt.Errorf("set kernel supervisor socket mode: %w", err)
	}
	return listener, nil
}

func serveKernels(ctx context.Context, listener *net.UnixListener) (int, error) {
	requests := 0
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return requests, nil
			}
			return requests, fmt.Errorf("accept kernel proxy request: %w", err)
		}
		if requests >= 1 {
			connection.Close()
			return requests, errors.New("Prime session requested more than one Python kernel")
		}
		if err := handle(ctx, connection); err != nil {
			connection.Close()
			return requests, err
		}
		connection.Close()
		requests += 1
	}
}

func handle(ctx context.Context, connection *net.UnixConn) error {
	uid, err := supervisor.PeerUID(connection)
	if err != nil {
		return err
	}
	if err := supervisor.ValidatePeerUID(uid); err != nil {
		return err
	}
	request, err := supervisor.ReadRequest(connection)
	if err != nil {
		return err
	}
	exitCode, diagnostic := supervisor.RunKernel(ctx, request)
	if ctx.Err() != nil {
		return nil
	}
	return supervisor.WriteResponse(connection, kernelcontract.Response{
		Version:  1,
		ExitCode: exitCode,
		Error:    diagnostic,
	})
}
