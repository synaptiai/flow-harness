package kernelcontract

import "testing"

func TestRequestFromArgsAcceptsOnlyThePinnedProvisionerKernelLaunch(t *testing.T) {
	connectionPath := "/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json"
	request, err := RequestFromArgs([]string{"-m", "ipykernel_launcher", "-f", connectionPath})
	if err != nil {
		t.Fatalf("fixed kernel launch failed: %v", err)
	}
	if request.ConnectionPath != connectionPath {
		t.Fatalf("connection path changed: %q", request.ConnectionPath)
	}

	for _, args := range [][]string{
		{"-c", "print('unsafe')"},
		{"-m", "site", "-f", connectionPath},
		{"-m", "ipykernel_launcher", "-f", "/workspace/.flow-prime/control/connection.json"},
		{"-m", "ipykernel_launcher", "-f", "/workspace/connection.json"},
	} {
		if _, err := RequestFromArgs(args); err == nil {
			t.Fatalf("unsafe kernel launch passed: %#v", args)
		}
	}
}

func TestProvisionerConnectionPathGrammarIsClosed(t *testing.T) {
	for _, path := range []string{
		"/workspace/.flow-prime/control/prime-agent-kernel-000000/connection.json",
		"/workspace/.flow-prime/control/prime-agent-kernel-Zz9Yy8/connection.json",
	} {
		if !IsProvisionerConnectionPath(path) {
			t.Fatalf("pinned provisioner path failed: %q", path)
		}
	}

	for _, path := range []string{
		"/workspace/.flow-prime/control/connection.json",
		"/workspace/.flow-prime/control/prime-agent-kernel-12345/connection.json",
		"/workspace/.flow-prime/control/prime-agent-kernel-1234567/connection.json",
		"/workspace/.flow-prime/control/prime-agent-kernel-12345_/connection.json",
		"/workspace/.flow-prime/control/prime-agent-kernel-12345é/connection.json",
		"/workspace/.flow-prime/control/prime-agent-kernel-123456/other.json",
		"/workspace/.flow-prime/control/extra/prime-agent-kernel-123456/connection.json",
		"/workspace/.flow-prime/control/prime-agent-kernel-123456/../connection.json",
		"/run/flow-node/prime-agent-kernel-123456/connection.json",
	} {
		if IsProvisionerConnectionPath(path) {
			t.Fatalf("unsafe provisioner path passed: %q", path)
		}
	}
}

func TestPythonKernelLaunchAcceptsOnlyTheFixedPrivateConnectionFile(t *testing.T) {
	fixed := []string{"-m", "ipykernel_launcher", "-f", PythonConnectionPath}
	if err := ValidatePythonArgs(fixed); err != nil {
		t.Fatalf("fixed inherited descriptor failed: %v", err)
	}
	for _, args := range [][]string{
		{"-m", "ipykernel_launcher", "-f", "/workspace/.flow-prime/control/connection.json"},
		{"-m", "ipykernel_launcher", "-f", "/proc/self/fd/3"},
		{"-c", "print('unsafe')"},
	} {
		if err := ValidatePythonArgs(args); err == nil {
			t.Fatalf("unsafe Python kernel launch passed: %#v", args)
		}
	}
}
