//go:build !linux

package supervisor

import "errors"

func TerminatePythonProcesses() error {
	return errors.New("Prime Python settlement is supported only on Linux")
}
