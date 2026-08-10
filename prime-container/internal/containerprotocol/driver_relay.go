package containerprotocol

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
)

func RelayDriver(hostReader io.Reader, hostWriter io.Writer, driver io.ReadWriter, bootstrap []byte) error {
	if hostReader == nil || hostWriter == nil || driver == nil {
		return errors.New("Prime driver relay input is incomplete")
	}
	hello, err := ParseInnerHello(bootstrap)
	if err != nil {
		return err
	}
	if err := writeInnerLine(driver, bootstrap); err != nil {
		return err
	}
	reader := bufio.NewReaderSize(driver, MaxInnerFrameBytes+2)
	driverSequence := int64(1)
	parentSequence := int64(2)
	ready := false
	frames := 0
	for {
		line, err := readInnerLine(reader)
		if err != nil {
			return err
		}
		frames++
		if frames > MaxDriverFrames {
			return errors.New("Prime driver traffic exceeds the frame limit")
		}
		frame, err := ParseInnerDriver(line, InnerExpectation{
			SecretHex: hello.SecretHex, SessionID: hello.SessionID, Sequence: driverSequence,
		})
		if err != nil {
			return err
		}
		driverSequence++
		if !ready {
			if frame.Type != InnerReady {
				return errors.New("Prime driver must send ready before other frames")
			}
			ready = true
		} else if frame.Type == InnerReady {
			return errors.New("Prime driver sent more than one ready frame")
		}
		if err := WriteFrame(hostWriter, FrameDriver, line); err != nil {
			return err
		}
		switch frame.Type {
		case InnerInferenceRequest:
			parentFrame, err := ReadFrame(hostReader)
			if err != nil {
				return err
			}
			if parentFrame.Type != FrameDriver {
				return fmt.Errorf(
					"Prime container frame type %d cannot answer an inference request",
					parentFrame.Type,
				)
			}
			if _, err := ParseInnerParent(parentFrame.Payload, InnerExpectation{
				SecretHex: hello.SecretHex, SessionID: hello.SessionID, Sequence: parentSequence,
			}); err != nil {
				return err
			}
			parentSequence++
			if err := writeInnerLine(driver, parentFrame.Payload); err != nil {
				return err
			}
		case InnerTerminal:
			return WriteFrame(hostWriter, FrameTerminal, nil)
		}
	}
}

func readInnerLine(reader *bufio.Reader) ([]byte, error) {
	line, err := reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return nil, errors.New("Prime inner frame exceeds the byte limit")
	}
	if err != nil {
		return nil, fmt.Errorf("read Prime inner frame: %w", err)
	}
	if len(line) < 2 || len(line) > MaxInnerFrameBytes+1 || line[len(line)-1] != '\n' {
		return nil, errors.New("Prime inner frame line is invalid")
	}
	payload := line[:len(line)-1]
	if bytes.ContainsAny(payload, "\r\n") {
		return nil, errors.New("Prime inner frame contains an embedded line break")
	}
	return append([]byte(nil), payload...), nil
}

func writeInnerLine(writer io.Writer, payload []byte) error {
	if len(payload) < 1 || len(payload) > MaxInnerFrameBytes || bytes.ContainsAny(payload, "\r\n") {
		return errors.New("Prime inner frame line is invalid")
	}
	line := append(append(make([]byte, 0, len(payload)+1), payload...), '\n')
	for len(line) > 0 {
		written, err := writer.Write(line)
		if err != nil {
			return fmt.Errorf("write Prime inner frame: %w", err)
		}
		if written < 1 {
			return io.ErrShortWrite
		}
		line = line[written:]
	}
	return nil
}
