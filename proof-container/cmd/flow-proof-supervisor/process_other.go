//go:build !linux

package main

import (
	"errors"
	"fmt"
	"syscall"
	"time"
)

func proofProcessAttributes(_ uint32, _ uint32) *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

func terminateProofProcessGroup(pid int) error {
	err := syscall.Kill(-pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	if err != nil {
		return err
	}
	for range 100 {
		reapExitedProofChildren()
		err = syscall.Kill(-pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		if err != nil {
			return err
		}
		time.Sleep(time.Millisecond)
	}
	return fmt.Errorf("proof process group %d removal is unconfirmed", pid)
}

func reapExitedProofChildren() {
	for {
		child, _ := syscall.Wait4(-1, nil, syscall.WNOHANG, nil)
		if child <= 0 {
			return
		}
	}
}
