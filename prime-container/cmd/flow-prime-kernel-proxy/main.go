package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"

	"github.com/synaptiai/flow-harness/prime-container/internal/kernelcontract"
)

const supervisorSocket = "/run/flow-supervisor/kernel.sock"

func main() {
	request, err := kernelcontract.RequestFromArgs(os.Args[1:])
	if err != nil {
		fail(err)
	}
	connection, err := net.Dial("unix", supervisorSocket)
	if err != nil {
		fail(fmt.Errorf("connect to the kernel supervisor: %w", err))
	}
	defer connection.Close()
	if err := writeMessage(connection, request); err != nil {
		fail(err)
	}
	var response kernelcontract.Response
	if err := readMessage(connection, &response); err != nil {
		fail(err)
	}
	if response.Version != 1 || response.ExitCode < 0 || response.ExitCode > 255 {
		fail(errors.New("kernel supervisor response violates the fixed contract"))
	}
	if response.Error != "" {
		fmt.Fprintln(os.Stderr, response.Error)
	}
	os.Exit(response.ExitCode)
}

func writeMessage(writer io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil || len(payload) > kernelcontract.MaxMessageBytes {
		return errors.New("kernel request cannot be encoded")
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))
	if _, err := writer.Write(append(header, payload...)); err != nil {
		return fmt.Errorf("write kernel request: %w", err)
	}
	return nil
}

func readMessage(reader io.Reader, value any) error {
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil {
		return fmt.Errorf("read kernel response header: %w", err)
	}
	length := binary.BigEndian.Uint32(header)
	if length == 0 || length > kernelcontract.MaxMessageBytes {
		return errors.New("kernel response exceeds its byte limit")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return fmt.Errorf("read kernel response: %w", err)
	}
	if err := json.Unmarshal(payload, value); err != nil {
		return errors.New("kernel response is not valid JSON")
	}
	return nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(125)
}
