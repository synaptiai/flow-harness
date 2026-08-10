package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
	"github.com/synaptiai/flow-harness/prime-container/internal/supervisor"
)

const kernelSocket = "/run/flow-supervisor/kernel.sock"

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
	if err := os.MkdirAll(filepath.Dir(kernelSocket), 0700); err != nil {
		return fmt.Errorf("create kernel supervisor directory: %w", err)
	}
	if err := os.Remove(kernelSocket); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale kernel supervisor socket: %w", err)
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: kernelSocket, Net: "unix"})
	if err != nil {
		return fmt.Errorf("listen on kernel supervisor socket: %w", err)
	}
	defer listener.Close()
	if err := os.Chown(kernelSocket, supervisor.NodeUID, supervisor.SharedGID); err != nil {
		return fmt.Errorf("set kernel supervisor socket owner: %w", err)
	}
	if err := os.Chmod(kernelSocket, 0660); err != nil {
		return fmt.Errorf("set kernel supervisor socket mode: %w", err)
	}

	termination := make(chan os.Signal, 1)
	signal.Notify(termination, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(termination)
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			return fmt.Errorf("accept kernel proxy request: %w", err)
		}
		if err := handle(connection); err != nil {
			connection.Close()
			return err
		}
		connection.Close()
		select {
		case <-termination:
			return nil
		default:
		}
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
