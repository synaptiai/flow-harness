package main

import (
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
	type kernelServiceResult struct {
		requests int
		err      error
	}
	kernelResults := make(chan kernelServiceResult, 1)
	go func() {
		requests, serveError := serveKernels(listener)
		kernelResults <- kernelServiceResult{requests: requests, err: serveError}
	}()
	prepared, err := containerprotocol.ReceivePreparation(containerprotocol.PreparationInput{
		Reader: os.Stdin, Writer: os.Stdout, WorkspacePath: workspacePath,
		Ownership: containerprotocol.WorkspaceOwnership{
			EntryUID: supervisor.PythonUID, EntryGID: supervisor.PythonUID,
			RootUID: supervisor.PythonUID, RootGID: supervisor.SharedGID, RootMode: 0710,
		},
		Readiness: func(challenge containerprotocol.ReadinessChallenge) ([]byte, error) {
			measurement, err := supervisor.MeasureReadiness()
			if err != nil {
				return nil, err
			}
			return supervisor.BuildReadiness(challenge, measurement)
		},
	})
	if err != nil {
		return err
	}
	driverResult, err := supervisor.RunDriverProcess(
		os.Stdin,
		os.Stdout,
		prepared.Bootstrap,
		supervisor.DriverProcessOptions{
			Executable: nodePath,
			Arguments:  []string{"--no-addons", driverPath},
			Environment: []string{
				"HOME=/run/flow-node", "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
				"NODE_ENV=production", "PATH=/usr/local/bin:/usr/bin:/bin",
				"PRIME_AGENT_KERNEL_FORKSERVER=0", "TMPDIR=/run/flow-node",
			},
			WorkingDirectory: workspacePath,
			UID:              supervisor.NodeUID, GID: supervisor.NodeUID, Groups: []int{supervisor.SharedGID},
			MaxDiagnosticBytes: 65536,
		},
	)
	if err != nil {
		return fmt.Errorf("run Prime driver: %w", err)
	}
	if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		return fmt.Errorf("close kernel supervisor listener: %w", err)
	}
	kernelResult := <-kernelResults
	if kernelResult.err != nil && !errors.Is(kernelResult.err, net.ErrClosed) {
		return kernelResult.err
	}
	if err := supervisor.TerminatePythonProcesses(); err != nil {
		return err
	}
	exported, err := containerprotocol.CaptureWorkspace(workspacePath)
	if err != nil {
		return err
	}
	if err := exported.WriteResultFrames(os.Stdout); err != nil {
		return err
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
	return containerprotocol.WriteFrame(os.Stdout, containerprotocol.FrameSettlement, settlement)
}

func preparePrivatePaths() error {
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
		if err := os.MkdirAll(item.path, item.mode); err != nil {
			return fmt.Errorf("create Prime private path %s: %w", item.path, err)
		}
		if err := os.Chown(item.path, item.uid, item.gid); err != nil {
			return fmt.Errorf("set Prime private path owner %s: %w", item.path, err)
		}
		if err := os.Chmod(item.path, item.mode); err != nil {
			return fmt.Errorf("set Prime private path mode %s: %w", item.path, err)
		}
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

func serveKernels(listener *net.UnixListener) (int, error) {
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
		if err := handle(connection); err != nil {
			connection.Close()
			return requests, err
		}
		connection.Close()
		requests += 1
	}
}

func handle(connection *net.UnixConn) error {
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
	exitCode, diagnostic := supervisor.RunKernel(request)
	return supervisor.WriteResponse(connection, kernelcontract.Response{
		Version:  1,
		ExitCode: exitCode,
		Error:    diagnostic,
	})
}
