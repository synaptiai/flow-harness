//go:build !linux

package supervisor

import "errors"

func HardenSupervisor() error {
	return errors.New("Prime supervisor is supported only on Linux")
}

func MeasureReadiness() (ReadinessMeasurement, error) {
	return ReadinessMeasurement{}, errors.New("Prime readiness is supported only on Linux")
}
