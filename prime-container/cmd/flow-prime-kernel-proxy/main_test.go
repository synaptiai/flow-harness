package main

import (
	"errors"
	"fmt"
	"os"
	"reflect"
	"syscall"
	"testing"
	"time"
)

func TestAdmitKernelConnectionSettlesOneExactSharedFile(t *testing.T) {
	operations := []string{}
	file := &recordingKernelConnectionFile{
		operations:  &operations,
		information: fixedKernelConnectionFileInformation(),
	}
	filesystem := kernelConnectionFilesystem{
		open: func(path string, flags int, mode os.FileMode) (kernelConnectionFile, error) {
			operations = append(operations, fmt.Sprintf("open %s %#x %04o", path, flags, mode))
			return file, nil
		},
	}

	err := admitKernelConnectionWith(
		"/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json",
		filesystem,
	)
	if err != nil {
		t.Fatalf("admit kernel connection: %v", err)
	}
	want := []string{
		fmt.Sprintf(
			"open /workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json %#x 0000",
			os.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW,
		),
		"stat",
		"chown -1:10003",
		"chmod 0660",
		"close",
	}
	if !reflect.DeepEqual(operations, want) {
		t.Fatalf("kernel connection settlement changed:\n got: %#v\nwant: %#v", operations, want)
	}
}

func TestAdmitKernelConnectionRejectsBeforeSettlement(t *testing.T) {
	tests := []struct {
		name        string
		path        string
		information os.FileInfo
		statError   error
		message     string
	}{
		{
			name:        "path",
			path:        "/workspace/.flow-prime/control/connection.json",
			information: fixedKernelConnectionFileInformation(),
			message:     "kernel connection path does not match the fixed contract",
		},
		{
			name:        "stat",
			path:        "/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json",
			information: fixedKernelConnectionFileInformation(),
			statError:   errors.New("PRIVATE_STAT"),
			message:     "inspect fixed kernel connection file: PRIVATE_STAT",
		},
		{
			name: "identity",
			path: "/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json",
			information: testKernelConnectionFileInformation{
				mode: 0666,
				size: 64,
				stat: &syscall.Stat_t{Uid: 10001, Gid: 10001},
			},
			message: "kernel connection file violates the fixed proxy identity",
		},
		{
			name: "owner",
			path: "/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json",
			information: testKernelConnectionFileInformation{
				mode: 0600,
				size: 64,
				stat: &syscall.Stat_t{Uid: 10002, Gid: 10001},
			},
			message: "kernel connection file violates the fixed proxy identity",
		},
		{
			name: "group",
			path: "/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json",
			information: testKernelConnectionFileInformation{
				mode: 0600,
				size: 64,
				stat: &syscall.Stat_t{Uid: 10001, Gid: 10003},
			},
			message: "kernel connection file violates the fixed proxy identity",
		},
		{
			name: "directory",
			path: "/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json",
			information: testKernelConnectionFileInformation{
				mode: os.ModeDir | 0600,
				size: 64,
				stat: &syscall.Stat_t{Uid: 10001, Gid: 10001},
			},
			message: "kernel connection file violates the fixed proxy identity",
		},
		{
			name: "empty",
			path: "/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json",
			information: testKernelConnectionFileInformation{
				mode: 0600,
				size: 0,
				stat: &syscall.Stat_t{Uid: 10001, Gid: 10001},
			},
			message: "kernel connection file violates the fixed proxy identity",
		},
		{
			name: "oversized",
			path: "/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json",
			information: testKernelConnectionFileInformation{
				mode: 0600,
				size: 8193,
				stat: &syscall.Stat_t{Uid: 10001, Gid: 10001},
			},
			message: "kernel connection file violates the fixed proxy identity",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			operations := []string{}
			file := &recordingKernelConnectionFile{
				operations:  &operations,
				information: test.information,
				statError:   test.statError,
			}
			err := admitKernelConnectionWith(test.path, kernelConnectionFilesystem{
				open: func(_ string, _ int, _ os.FileMode) (kernelConnectionFile, error) {
					operations = append(operations, "open")
					return file, nil
				},
			})
			if err == nil || err.Error() != test.message {
				t.Fatalf("unexpected error: %v", err)
			}
			for _, operation := range operations {
				if operation == "chown -1:10003" || operation == "chmod 0660" {
					t.Fatalf("rejected connection was settled: %#v", operations)
				}
			}
		})
	}
}

func TestAdmitKernelConnectionPreservesOneFixedSettlementFailure(t *testing.T) {
	tests := []struct {
		name          string
		failOperation string
		message       string
		operations    []string
	}{
		{
			name:          "group",
			failOperation: "chown -1:10003",
			message:       "set fixed kernel connection group: PRIVATE_FAILURE",
			operations:    []string{"stat", "chown -1:10003", "close"},
		},
		{
			name:          "mode",
			failOperation: "chmod 0660",
			message:       "set fixed kernel connection mode: PRIVATE_FAILURE",
			operations:    []string{"stat", "chown -1:10003", "chmod 0660", "close"},
		},
		{
			name:          "close",
			failOperation: "close",
			message:       "close fixed kernel connection file: PRIVATE_FAILURE",
			operations:    []string{"stat", "chown -1:10003", "chmod 0660", "close"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			operations := []string{}
			file := &recordingKernelConnectionFile{
				operations:    &operations,
				information:   fixedKernelConnectionFileInformation(),
				failOperation: test.failOperation,
			}
			err := admitKernelConnectionWith(
				"/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json",
				kernelConnectionFilesystem{
					open: func(_ string, _ int, _ os.FileMode) (kernelConnectionFile, error) {
						return file, nil
					},
				},
			)
			if err == nil || err.Error() != test.message {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(operations, test.operations) {
				t.Fatalf("settlement failure order changed:\n got: %#v\nwant: %#v", operations, test.operations)
			}
		})
	}
}

type recordingKernelConnectionFile struct {
	operations    *[]string
	information   os.FileInfo
	statError     error
	failOperation string
}

func (file *recordingKernelConnectionFile) Stat() (os.FileInfo, error) {
	*file.operations = append(*file.operations, "stat")
	return file.information, file.statError
}

func (file *recordingKernelConnectionFile) Chown(uid int, gid int) error {
	operation := fmt.Sprintf("chown %d:%d", uid, gid)
	*file.operations = append(*file.operations, operation)
	if operation == file.failOperation {
		return errors.New("PRIVATE_FAILURE")
	}
	return nil
}

func (file *recordingKernelConnectionFile) Chmod(mode os.FileMode) error {
	operation := fmt.Sprintf("chmod %04o", mode)
	*file.operations = append(*file.operations, operation)
	if operation == file.failOperation {
		return errors.New("PRIVATE_FAILURE")
	}
	return nil
}

func (file *recordingKernelConnectionFile) Close() error {
	*file.operations = append(*file.operations, "close")
	if file.failOperation == "close" {
		return errors.New("PRIVATE_FAILURE")
	}
	return nil
}

type testKernelConnectionFileInformation struct {
	mode os.FileMode
	size int64
	stat *syscall.Stat_t
}

func (information testKernelConnectionFileInformation) Name() string       { return "connection.json" }
func (information testKernelConnectionFileInformation) Size() int64        { return information.size }
func (information testKernelConnectionFileInformation) Mode() os.FileMode  { return information.mode }
func (information testKernelConnectionFileInformation) ModTime() time.Time { return time.Time{} }
func (information testKernelConnectionFileInformation) IsDir() bool        { return false }
func (information testKernelConnectionFileInformation) Sys() any           { return information.stat }

func fixedKernelConnectionFileInformation() os.FileInfo {
	return testKernelConnectionFileInformation{
		mode: 0600,
		size: 64,
		stat: &syscall.Stat_t{Uid: 10001, Gid: 10001},
	}
}
