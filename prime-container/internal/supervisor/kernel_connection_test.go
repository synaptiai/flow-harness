package supervisor

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
)

func TestCleanupKernelConnectionRemovesTheFileBeforeItsDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "prime-agent-kernel-aB09Zx")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatalf("create kernel connection directory: %v", err)
	}
	path := filepath.Join(directory, kernelcontract.ConnectionFileName)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_EXCL, 0600)
	if err != nil {
		t.Fatalf("create kernel connection file: %v", err)
	}

	cleanupKernelConnection(file, path)

	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("kernel connection directory remains after cleanup: %v", err)
	}
	if _, err := file.Write([]byte("closed")); err == nil {
		t.Fatal("kernel connection descriptor remains open after cleanup")
	}
}

func TestInitialKernelConnectionRequiresThePinnedZeroPortIdentity(t *testing.T) {
	initial := fixedInitialKernelConnection()
	value, err := json.MarshalIndent(initial, "", "  ")
	if err != nil {
		t.Fatalf("encode initial connection: %v", err)
	}
	parsed, err := parseInitialKernelConnection(value)
	if err != nil {
		t.Fatalf("parse initial connection: %v", err)
	}
	if parsed != initial {
		t.Fatalf("initial connection changed: %#v", parsed)
	}

	mutations := []struct {
		name   string
		mutate func(*kernelConnectionInformation)
	}{
		{name: "IP", mutate: func(value *kernelConnectionInformation) { value.IP = "0.0.0.0" }},
		{name: "transport", mutate: func(value *kernelConnectionInformation) { value.Transport = "ipc" }},
		{name: "port", mutate: func(value *kernelConnectionInformation) { value.ShellPort = 1 }},
		{name: "scheme", mutate: func(value *kernelConnectionInformation) { value.SignatureScheme = "none" }},
		{name: "key", mutate: func(value *kernelConnectionInformation) { value.Key = "00" }},
		{name: "kernel", mutate: func(value *kernelConnectionInformation) { value.KernelName = "other" }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			changed := initial
			mutation.mutate(&changed)
			encoded, encodeError := json.Marshal(changed)
			if encodeError != nil {
				t.Fatalf("encode mutation: %v", encodeError)
			}
			if _, parseError := parseInitialKernelConnection(encoded); parseError == nil {
				t.Fatal("mutated initial connection passed")
			}
		})
	}
}

func TestResolvedKernelConnectionChangesOnlyToFiveDistinctPorts(t *testing.T) {
	initial := fixedInitialKernelConnection()
	resolved := initial
	resolved.ShellPort = 41001
	resolved.IopubPort = 41002
	resolved.StdinPort = 41003
	resolved.ControlPort = 41004
	resolved.HeartbeatPort = 41005
	value, err := json.MarshalIndent(resolved, "", "  ")
	if err != nil {
		t.Fatalf("encode resolved connection: %v", err)
	}
	canonical, err := parseResolvedKernelConnection(value, initial)
	if err != nil {
		t.Fatalf("parse resolved connection: %v", err)
	}
	var parsed kernelConnectionInformation
	if err := json.Unmarshal(canonical, &parsed); err != nil {
		t.Fatalf("decode canonical connection: %v", err)
	}
	if parsed != resolved {
		t.Fatalf("resolved connection changed: %#v", parsed)
	}

	mutations := []struct {
		name   string
		mutate func(*kernelConnectionInformation)
	}{
		{name: "IP", mutate: func(value *kernelConnectionInformation) { value.IP = "0.0.0.0" }},
		{name: "key", mutate: func(value *kernelConnectionInformation) { value.Key = "00112233445566778899aabbccddeeff" }},
		{name: "zero port", mutate: func(value *kernelConnectionInformation) { value.ShellPort = 0 }},
		{name: "large port", mutate: func(value *kernelConnectionInformation) { value.ShellPort = 65536 }},
		{name: "duplicate port", mutate: func(value *kernelConnectionInformation) { value.ShellPort = value.IopubPort }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			changed := resolved
			mutation.mutate(&changed)
			encoded, encodeError := json.Marshal(changed)
			if encodeError != nil {
				t.Fatalf("encode mutation: %v", encodeError)
			}
			if _, parseError := parseResolvedKernelConnection(encoded, initial); parseError == nil {
				t.Fatal("mutated resolved connection passed")
			}
		})
	}

	privateExtension := append(value[:len(value)-1], []byte(`,"private":"PRIVATE_CONNECTION"}`)...)
	if _, err := parseResolvedKernelConnection(privateExtension, initial); err == nil {
		t.Fatal("unknown resolved connection field passed")
	}
	oversized := bytes.Repeat([]byte(" "), kernelcontract.MaxMessageBytes+1)
	if _, err := parseResolvedKernelConnection(oversized, initial); err == nil {
		t.Fatal("oversized resolved connection passed")
	}
}

func fixedInitialKernelConnection() kernelConnectionInformation {
	return kernelConnectionInformation{
		IP:              "127.0.0.1",
		Transport:       "tcp",
		ShellPort:       0,
		IopubPort:       0,
		StdinPort:       0,
		ControlPort:     0,
		HeartbeatPort:   0,
		SignatureScheme: "hmac-sha256",
		Key:             "0123456789abcdef0123456789abcdef",
		KernelName:      "python3",
	}
}
