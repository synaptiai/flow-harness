//go:build linux

package supervisor

import (
	"errors"
	"fmt"
	"syscall"
	"time"
)

const pythonSettlementTimeout = 5 * time.Second

func TerminatePythonProcesses() error {
	deadline := time.Now().Add(pythonSettlementTimeout)
	for {
		processes, err := listProcessesByUID("/proc", PythonUID)
		if err != nil {
			return err
		}
		if len(processes) == 0 {
			return nil
		}
		for _, process := range processes {
			if err := syscall.Kill(process, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				return fmt.Errorf("terminate Prime Python process %d: %w", process, err)
			}
		}
		if time.Now().After(deadline) {
			return errors.New("Prime Python process tree did not settle within five seconds")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
