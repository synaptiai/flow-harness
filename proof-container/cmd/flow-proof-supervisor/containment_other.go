//go:build !linux

package main

import "errors"

func verifyRuntimeContainment() error {
	return errors.New("Lean proof supervisor requires Linux containment")
}
