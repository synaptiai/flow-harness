package supervisor

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestReadRequestAndPeerUserAreClosed(t *testing.T) {
	connectionPath := "/workspace/.flow-prime/control/prime-agent-kernel-aB09Zx/connection.json"
	payload := []byte(`{"version":1,"connectionPath":"` + connectionPath + `"}`)
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))
	request, err := ReadRequest(bytes.NewReader(append(header, payload...)))
	if err != nil {
		t.Fatalf("fixed request failed: %v", err)
	}
	if request.ConnectionPath != connectionPath {
		t.Fatalf("connection path changed: %q", request.ConnectionPath)
	}
	if err := ValidatePeerUID(NodeUID); err != nil {
		t.Fatalf("fixed Node user failed: %v", err)
	}
	if err := ValidatePeerUID(PythonUID); err == nil {
		t.Fatal("Python user passed the Node peer check")
	}
}
