package supervisor

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/synaptiai/flow-harness/prime-container/internal/containerprotocol"
)

func TestBuildReadinessBindsChallengeAndMeasuredControls(t *testing.T) {
	challenge := containerprotocol.ReadinessChallenge{
		Version:        1,
		ContainerID:    strings.Repeat("a", 64),
		TrialID:        "trial-" + strings.Repeat("b", 48),
		IdentityDigest: strings.Repeat("c", 64),
		ImageID:        "sha256:" + strings.Repeat("d", 64),
		PolicyDigest:   strings.Repeat("e", 64),
	}
	measurement := fixedReadinessMeasurement()

	payload, err := BuildReadiness(challenge, measurement)
	if err != nil {
		t.Fatalf("build readiness: %v", err)
	}
	var readiness Readiness
	if err := json.Unmarshal(payload, &readiness); err != nil {
		t.Fatalf("parse readiness: %v", err)
	}
	if readiness.ContainerID != challenge.ContainerID || readiness.TrialID != challenge.TrialID ||
		readiness.IdentityDigest != challenge.IdentityDigest || readiness.ImageID != challenge.ImageID ||
		readiness.PolicyDigest != challenge.PolicyDigest {
		t.Fatalf("readiness challenge changed: %#v", readiness)
	}
	if !reflect.DeepEqual(readiness.Process, measurement.Process) || readiness.Limits != measurement.Limits {
		t.Fatalf("readiness measurements changed: %#v", readiness)
	}
	if readiness.Filesystems.Workspace.Bytes != 536870912 || readiness.Network.Interfaces[0] != "lo" {
		t.Fatalf("readiness boundary changed: %#v", readiness)
	}
}

func TestBuildReadinessRejectsAChangedFixedIdentity(t *testing.T) {
	measurement := fixedReadinessMeasurement()
	measurement.Process.NodeUID = 999
	if _, err := BuildReadiness(containerprotocol.ReadinessChallenge{
		Version:        1,
		ContainerID:    strings.Repeat("a", 64),
		TrialID:        "trial-" + strings.Repeat("b", 48),
		IdentityDigest: strings.Repeat("c", 64),
		ImageID:        "sha256:" + strings.Repeat("d", 64),
		PolicyDigest:   strings.Repeat("e", 64),
	}, measurement); err == nil {
		t.Fatal("changed fixed Node identity passed readiness")
	}
}

func fixedReadinessMeasurement() ReadinessMeasurement {
	return ReadinessMeasurement{
		Process: ProcessReadiness{
			SupervisorUID: 0, NodeUID: NodeUID, PythonUID: PythonUID, SharedGID: SharedGID,
			SupplementaryGroups: []int{SharedGID},
			Capabilities:        []string{"CHOWN", "DAC_READ_SEARCH", "FOWNER", "KILL", "SETGID", "SETUID"},
			Dumpable:            false, NoNewPrivileges: true, SeccompMode: 2,
			CoreSoftBytes: 0, CoreHardBytes: 0,
		},
		Limits: LimitReadiness{
			CgroupVersion: 2, PidsMax: 64, MemoryMaxBytes: 2147483648, MemorySwapMaxBytes: 0,
			CPUQuotaMicros: 200000, CPUPeriodMicros: 100000,
			OpenFilesSoft: 256, OpenFilesHard: 256, UserProcessesSoft: 64, UserProcessesHard: 64,
			FileSizeSoftBytes: 268435456, FileSizeHardBytes: 268435456,
		},
		Filesystems: FilesystemReadiness{
			RootReadOnly:      true,
			Workspace:         fixedFilesystem(536870912, 8192, 0710),
			NodeRuntime:       fixedFilesystem(16777216, 256, 0700),
			SupervisorRuntime: fixedFilesystem(16777216, 256, 0700),
		},
		Network:   NetworkReadiness{Namespace: "private", Interfaces: []string{"lo"}, Routes: []string{}},
		Streams:   StreamReadiness{StdinAttached: true, StdoutAttached: true, StderrAttached: true, TTY: false},
		LogDriver: "none", Healthcheck: "none",
	}
}

func fixedFilesystem(bytes int64, inodes int64, mode int) FilesystemControl {
	return FilesystemControl{
		Type: "tmpfs", Bytes: bytes, Inodes: inodes, Mode: mode,
		Nosuid: true, Nodev: true, Noexec: true,
	}
}
