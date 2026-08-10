package containerprotocol

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

type PreparationInput struct {
	Reader        io.Reader
	Writer        io.Writer
	WorkspacePath string
	Ownership     WorkspaceOwnership
	Readiness     func(ReadinessChallenge) ([]byte, error)
}

type PreparedSession struct {
	Challenge ReadinessChallenge
	Bootstrap []byte
}

func ReceivePreparation(input PreparationInput) (PreparedSession, error) {
	if input.Reader == nil || input.Writer == nil || input.Readiness == nil || input.WorkspacePath == "" {
		return PreparedSession{}, errors.New("Prime preparation input is incomplete")
	}
	challengeFrame, err := ReadFrame(input.Reader)
	if err != nil {
		return PreparedSession{}, err
	}
	if challengeFrame.Type != FrameAttestationChallenge {
		return PreparedSession{}, errors.New("Prime preparation must start with an attestation challenge")
	}
	challenge, err := ParseReadinessChallenge(challengeFrame.Payload)
	if err != nil {
		return PreparedSession{}, err
	}
	readiness, err := input.Readiness(challenge)
	if err != nil {
		return PreparedSession{}, fmt.Errorf("measure Prime container readiness: %w", err)
	}
	if len(readiness) < 1 || !utf8.Valid(readiness) {
		return PreparedSession{}, errors.New("Prime readiness is not nonempty UTF-8")
	}
	if err := WriteFrame(input.Writer, FrameReadiness, readiness); err != nil {
		return PreparedSession{}, err
	}

	startFrame, err := ReadFrame(input.Reader)
	if err != nil {
		return PreparedSession{}, err
	}
	if startFrame.Type != FrameFixtureStart {
		return PreparedSession{}, errors.New("Prime readiness must be followed by fixture start")
	}
	start, err := ParseTransferStart(startFrame.Payload)
	if err != nil {
		return PreparedSession{}, err
	}
	importer, err := NewWorkspaceImporter(input.WorkspacePath, start, input.Ownership)
	if err != nil {
		return PreparedSession{}, err
	}
	defer importer.Close()
	frames := 1
	for {
		frame, err := ReadFrame(input.Reader)
		if err != nil {
			return PreparedSession{}, err
		}
		frames++
		if frames > MaxTransferFrames {
			return PreparedSession{}, errors.New("Prime fixture transfer exceeds the frame limit")
		}
		switch frame.Type {
		case FrameFixtureEntry:
			entry, err := ParseManifestEntry(frame.Payload)
			if err != nil {
				return PreparedSession{}, err
			}
			if err := importer.AddEntry(entry); err != nil {
				return PreparedSession{}, err
			}
		case FrameFixtureChunk:
			if err := importer.AddChunk(frame.Payload); err != nil {
				return PreparedSession{}, err
			}
		case FrameFixtureFileEnd:
			if len(frame.Payload) != 0 {
				return PreparedSession{}, errors.New("Prime fixture file end payload must be empty")
			}
			if err := importer.EndFile(); err != nil {
				return PreparedSession{}, err
			}
		case FrameFixtureComplete:
			if len(frame.Payload) != 0 {
				return PreparedSession{}, errors.New("Prime fixture completion payload must be empty")
			}
			if _, err := importer.Complete(); err != nil {
				return PreparedSession{}, err
			}
			bootstrap, err := readBootstrap(input.Reader)
			if err != nil {
				return PreparedSession{}, err
			}
			return PreparedSession{
				Challenge: challenge,
				Bootstrap: bootstrap,
			}, nil
		default:
			return PreparedSession{}, fmt.Errorf(
				"Prime container frame type %d is invalid during fixture transfer",
				frame.Type,
			)
		}
	}
}

func readBootstrap(reader io.Reader) ([]byte, error) {
	frame, err := ReadFrame(reader)
	if err != nil {
		return nil, err
	}
	if frame.Type != FrameBootstrap {
		return nil, errors.New("Prime fixture completion must be followed by bootstrap")
	}
	if len(frame.Payload) < 1 || !utf8.Valid(frame.Payload) || bytes.ContainsAny(frame.Payload, "\r\n") {
		return nil, errors.New("Prime bootstrap must be one nonempty UTF-8 line")
	}
	return append([]byte(nil), frame.Payload...), nil
}
