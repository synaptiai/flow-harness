package supervisor

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
)

type kernelConnectionInformation struct {
	IP              string `json:"ip"`
	Transport       string `json:"transport"`
	ShellPort       int    `json:"shell_port"`
	IopubPort       int    `json:"iopub_port"`
	StdinPort       int    `json:"stdin_port"`
	ControlPort     int    `json:"control_port"`
	HeartbeatPort   int    `json:"hb_port"`
	SignatureScheme string `json:"signature_scheme"`
	Key             string `json:"key"`
	KernelName      string `json:"kernel_name"`
}

func cleanupKernelConnection(file *os.File, path string) {
	_ = file.Close()
	_ = os.Remove(path)
	_ = os.Remove(filepath.Dir(path))
}

func parseInitialKernelConnection(value []byte) (kernelConnectionInformation, error) {
	connection, err := parseKernelConnection(value)
	if err != nil || !validCommonKernelConnection(connection) || !allKernelPorts(connection, 0) {
		return kernelConnectionInformation{}, errors.New("kernel connection file violates the fixed schema")
	}
	return connection, nil
}

func parseResolvedKernelConnection(
	value []byte,
	initial kernelConnectionInformation,
) ([]byte, error) {
	connection, err := parseKernelConnection(value)
	if err != nil || !validCommonKernelConnection(connection) ||
		connection.IP != initial.IP || connection.Transport != initial.Transport ||
		connection.SignatureScheme != initial.SignatureScheme || connection.Key != initial.Key ||
		connection.KernelName != initial.KernelName || !validResolvedKernelPorts(connection) {
		return nil, errors.New("resolved kernel connection violates the fixed schema")
	}
	canonical, err := json.Marshal(connection)
	if err != nil || len(canonical) > kernelcontract.MaxMessageBytes {
		return nil, errors.New("resolved kernel connection cannot be encoded")
	}
	return canonical, nil
}

func parseKernelConnection(value []byte) (kernelConnectionInformation, error) {
	if len(value) < 1 || len(value) > kernelcontract.MaxMessageBytes {
		return kernelConnectionInformation{}, errors.New("kernel connection exceeds its byte limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	var connection kernelConnectionInformation
	if err := decoder.Decode(&connection); err != nil {
		return kernelConnectionInformation{}, err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return kernelConnectionInformation{}, errors.New("kernel connection has trailing data")
	}
	return connection, nil
}

func validCommonKernelConnection(connection kernelConnectionInformation) bool {
	key, err := hex.DecodeString(connection.Key)
	return err == nil && len(key) == 16 && connection.IP == "127.0.0.1" &&
		connection.Transport == "tcp" && connection.SignatureScheme == "hmac-sha256" &&
		connection.KernelName == "python3"
}

func allKernelPorts(connection kernelConnectionInformation, value int) bool {
	return connection.ShellPort == value && connection.IopubPort == value &&
		connection.StdinPort == value && connection.ControlPort == value &&
		connection.HeartbeatPort == value
}

func validResolvedKernelPorts(connection kernelConnectionInformation) bool {
	ports := []int{
		connection.ShellPort,
		connection.IopubPort,
		connection.StdinPort,
		connection.ControlPort,
		connection.HeartbeatPort,
	}
	seen := make(map[int]struct{}, len(ports))
	for _, port := range ports {
		if port < 1 || port > 65535 {
			return false
		}
		if _, duplicate := seen[port]; duplicate {
			return false
		}
		seen[port] = struct{}{}
	}
	return true
}
