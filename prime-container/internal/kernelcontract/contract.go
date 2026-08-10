package kernelcontract

import (
	"encoding/json"
	"errors"
	"path/filepath"
)

const (
	ConnectionPath  = "/workspace/.flow-prime/control/connection.json"
	MaxMessageBytes = 8192
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
	if filepath.Clean(args[3]) != ConnectionPath || !filepath.IsAbs(args[3]) {
		return Request{}, errors.New("kernel connection path does not match the fixed contract")
	}
	return Request{Version: 1, ConnectionPath: ConnectionPath}, nil
}

func ParseRequest(value []byte) (Request, error) {
	if len(value) == 0 || len(value) > MaxMessageBytes {
		return Request{}, errors.New("kernel request exceeds its byte limit")
	}
	var request Request
	if err := json.Unmarshal(value, &request); err != nil {
		return Request{}, errors.New("kernel request is not valid JSON")
	}
	if request.Version != 1 || request.ConnectionPath != ConnectionPath {
		return Request{}, errors.New("kernel request violates the fixed contract")
	}
	canonical, err := json.Marshal(request)
	if err != nil || string(canonical) != string(value) {
		return Request{}, errors.New("kernel request is not canonical JSON")
	}
	return request, nil
}
