package main

import (
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"
)

func TestPrimeDriverProcessOptionsPermitThePinnedNativeAddon(t *testing.T) {
	options := primeDriverProcessOptions()
	if !reflect.DeepEqual(options.Arguments, []string{driverPath}) {
		t.Fatalf("Prime driver arguments changed: %#v", options.Arguments)
	}
}

func TestPreparePrivatePathsCreatesTheTreeBeforeSettlingTheRoot(t *testing.T) {
	operations := []string{}
	filesystem := privatePathFilesystem{
		mkdirAll: func(path string, mode os.FileMode) error {
			operations = append(operations, fmt.Sprintf("mkdir %s %04o", path, mode))
			return nil
		},
		chown: func(path string, uid int, gid int) error {
			operations = append(operations, fmt.Sprintf("chown %s %d:%d", path, uid, gid))
			return nil
		},
		chmod: func(path string, mode os.FileMode) error {
			operations = append(operations, fmt.Sprintf("chmod %s %04o", path, mode))
			return nil
		},
	}

	if err := preparePrivatePathsWith(filesystem); err != nil {
		t.Fatalf("prepare private paths: %v", err)
	}
	want := []string{
		"mkdir /run/flow-node 0700",
		"mkdir /workspace/.flow-prime 0700",
		"mkdir /workspace/.flow-prime/home 0700",
		"mkdir /workspace/.flow-prime/tmp 0700",
		"mkdir /workspace/.flow-prime/control 0700",
		"chown /run/flow-node 10001:10001", "chmod /run/flow-node 0700",
		"chown /workspace/.flow-prime/home 10002:10002", "chmod /workspace/.flow-prime/home 0700",
		"chown /workspace/.flow-prime/tmp 10002:10002", "chmod /workspace/.flow-prime/tmp 0700",
		"chown /workspace/.flow-prime/control 10001:10003", "chmod /workspace/.flow-prime/control 0770",
		"chown /workspace/.flow-prime 10002:10003", "chmod /workspace/.flow-prime 0710",
	}
	if !reflect.DeepEqual(operations, want) {
		t.Fatalf("private path operation order changed:\n got: %#v\nwant: %#v", operations, want)
	}
}

func TestPreparePrivatePathsPreservesOneFixedFailureStage(t *testing.T) {
	tests := []struct {
		name          string
		failOperation string
		message       string
	}{
		{name: "create", failOperation: "mkdir /workspace/.flow-prime/control 0700", message: "create Prime private path /workspace/.flow-prime/control: PRIVATE_FAILURE"},
		{name: "owner", failOperation: "chown /workspace/.flow-prime/control 10001:10003", message: "set Prime private path owner /workspace/.flow-prime/control: PRIVATE_FAILURE"},
		{name: "mode", failOperation: "chmod /workspace/.flow-prime/control 0770", message: "set Prime private path mode /workspace/.flow-prime/control: PRIVATE_FAILURE"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			operations := []string{}
			privateFailure := errors.New("PRIVATE_FAILURE")
			record := func(operation string) error {
				operations = append(operations, operation)
				if operation == test.failOperation {
					return privateFailure
				}
				return nil
			}
			filesystem := privatePathFilesystem{
				mkdirAll: func(path string, mode os.FileMode) error {
					return record(fmt.Sprintf("mkdir %s %04o", path, mode))
				},
				chown: func(path string, uid int, gid int) error {
					return record(fmt.Sprintf("chown %s %d:%d", path, uid, gid))
				},
				chmod: func(path string, mode os.FileMode) error {
					return record(fmt.Sprintf("chmod %s %04o", path, mode))
				},
			}

			err := preparePrivatePathsWith(filesystem)
			if err == nil || err.Error() != test.message {
				t.Fatalf("unexpected private path failure: %v", err)
			}
			if operations[len(operations)-1] != test.failOperation {
				t.Fatalf("operations continued after failure: %#v", operations)
			}
			for _, operation := range operations {
				if operation == "chown /workspace/.flow-prime 10002:10003" ||
					operation == "chmod /workspace/.flow-prime 0710" {
					t.Fatalf("private path root settled after a leaf failure: %#v", operations)
				}
			}
		})
	}
}
