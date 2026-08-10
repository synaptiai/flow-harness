package main

import (
	"fmt"
	"os"
	"syscall"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
)

const pythonExecutable = "/opt/flow/python/bin/python3"

func main() {
	request, err := kernelcontract.RequestFromArgs(os.Args[1:])
	if err != nil {
		fail(err)
	}
	if err := os.Chdir("/workspace"); err != nil {
		fail(fmt.Errorf("enter the fixed Python workspace: %w", err))
	}
	args := []string{
		pythonExecutable,
		"-I",
		"-m",
		"ipykernel_launcher",
		"-f",
		request.ConnectionPath,
	}
	environment := []string{
		"HOME=/workspace/.flow-prime/home",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"PATH=/opt/flow/python/bin:/usr/bin:/bin",
		"PYTHONNOUSERSITE=1",
		"PYTHONHASHSEED=0",
		"TMPDIR=/workspace/.flow-prime/tmp",
	}
	if err := syscall.Exec(pythonExecutable, args, environment); err != nil {
		fail(fmt.Errorf("start the fixed Python kernel: %w", err))
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(125)
}
