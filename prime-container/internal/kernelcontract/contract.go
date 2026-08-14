package kernelcontract

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
)

const (
	ConnectionRoot       = "/workspace/.flow-prime/control"
	ConnectionFileName   = "connection.json"
	ConnectionDirPrefix  = "prime-agent-kernel-"
	PythonConnectionPath = "/workspace/.flow-prime/tmp/connection.json"
	MaxMessageBytes      = 8192
	NodeUID              = 10001
	SharedGID            = 10003
)

type Request struct {
	Version        int    `json:"version"`
	ConnectionPath string `json:"connectionPath"`
}

type Response struct {
	Version  int    `json:"version"`
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error,omitempty"`
}

func RequestFromArgs(args []string) (Request, error) {
	if len(args) != 4 || args[0] != "-m" || args[1] != "ipykernel_launcher" || args[2] != "-f" {
		return Request{}, errors.New("kernel launch arguments do not match the fixed contract")
	}
	if !IsProvisionerConnectionPath(args[3]) {
		return Request{}, errors.New("kernel connection path does not match the fixed contract")
	}
	return Request{Version: 1, ConnectionPath: args[3]}, nil
}

func ValidatePythonArgs(args []string) error {
	if len(args) != 4 || args[0] != "-m" || args[1] != "ipykernel_launcher" ||
		args[2] != "-f" || args[3] != PythonConnectionPath {
		return errors.New("Python kernel launch arguments do not match the fixed contract")
	}
	return nil
}

func ParseRequest(value []byte) (Request, error) {
	if len(value) == 0 || len(value) > MaxMessageBytes {
		return Request{}, errors.New("kernel request exceeds its byte limit")
	}
	var request Request
	if err := json.Unmarshal(value, &request); err != nil {
		return Request{}, errors.New("kernel request is not valid JSON")
	}
	if request.Version != 1 || !IsProvisionerConnectionPath(request.ConnectionPath) {
		return Request{}, errors.New("kernel request violates the fixed contract")
	}
	canonical, err := json.Marshal(request)
	if err != nil || string(canonical) != string(value) {
		return Request{}, errors.New("kernel request is not canonical JSON")
	}
	return request, nil
}

func IsProvisionerConnectionPath(path string) bool {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Base(path) != ConnectionFileName {
		return false
	}
	directory := filepath.Dir(path)
	if filepath.Dir(directory) != ConnectionRoot {
		return false
	}
	name := filepath.Base(directory)
	if !strings.HasPrefix(name, ConnectionDirPrefix) {
		return false
	}
	suffix := strings.TrimPrefix(name, ConnectionDirPrefix)
	if len(suffix) != 6 {
		return false
	}
	for _, character := range suffix {
		if !isAsciiAlphanumeric(character) {
			return false
		}
	}
	return true
}

func isAsciiAlphanumeric(character rune) bool {
	return character >= '0' && character <= '9' ||
		character >= 'A' && character <= 'Z' ||
		character >= 'a' && character <= 'z'
}
