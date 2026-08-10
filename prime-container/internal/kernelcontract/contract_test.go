package kernelcontract

import "testing"

func TestRequestFromArgsAcceptsOnlyTheFixedKernelLaunch(t *testing.T) {
	request, err := RequestFromArgs([]string{"-m", "ipykernel_launcher", "-f", ConnectionPath})
	if err != nil {
		t.Fatalf("fixed kernel launch failed: %v", err)
	}
	if request.ConnectionPath != ConnectionPath {
		t.Fatalf("connection path changed: %q", request.ConnectionPath)
	}

	for _, args := range [][]string{
		{"-c", "print('unsafe')"},
		{"-m", "site", "-f", ConnectionPath},
		{"-m", "ipykernel_launcher", "-f", "/workspace/connection.json"},
	} {
		if _, err := RequestFromArgs(args); err == nil {
			t.Fatalf("unsafe kernel launch passed: %#v", args)
		}
	}
}
