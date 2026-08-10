package supervisor

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
)

const (
	NodeUID   = 10001
	PythonUID = 10002
	SharedGID = 10003
)

func ReadRequest(reader io.Reader) (kernelcontract.Request, error) {
	payload, err := readMessage(reader)
	if err != nil {
		return kernelcontract.Request{}, err
	}
	return kernelcontract.ParseRequest(payload)
}

func WriteResponse(writer io.Writer, response kernelcontract.Response) error {
	payload, err := json.Marshal(response)
	if err != nil || len(payload) > kernelcontract.MaxMessageBytes {
		return errors.New("kernel response cannot be encoded")
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))
	if _, err := writer.Write(append(header, payload...)); err != nil {
		return fmt.Errorf("write kernel response: %w", err)
	}
	return nil
}

func ValidatePeerUID(uid int) error {
	if uid != NodeUID {
		return fmt.Errorf("kernel request peer user %d is not the fixed Node user", uid)
	}
	return nil
}

func readMessage(reader io.Reader) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, fmt.Errorf("read kernel request header: %w", err)
	}
	length := binary.BigEndian.Uint32(header)
	if length == 0 || length > kernelcontract.MaxMessageBytes {
		return nil, errors.New("kernel request exceeds its byte limit")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, fmt.Errorf("read kernel request: %w", err)
	}
	return payload, nil
}
