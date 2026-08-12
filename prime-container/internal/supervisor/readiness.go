package supervisor

import (
	"encoding/json"
	"errors"
	"reflect"

	"github.com/synaptiai/flow-harness/prime-container/internal/containerprotocol"
)

const (
	fixedHostnameSource = "flow-prime\n"
	fixedHostsSource    = "127.0.0.1 localhost flow-prime\n::1 localhost ip6-localhost ip6-loopback\n"
	fixedResolverSource = "nameserver 127.0.0.1\nsearch .\noptions ndots:0\n"
)

type ProcessReadiness struct {
	SupervisorPID       int      `json:"supervisorPid"`
	SupervisorUID       int      `json:"supervisorUid"`
	NodeUID             int      `json:"nodeUid"`
	PythonUID           int      `json:"pythonUid"`
	SharedGID           int      `json:"sharedGid"`
	SupplementaryGroups []int    `json:"supplementaryGroups"`
	Capabilities        []string `json:"capabilities"`
	Dumpable            bool     `json:"dumpable"`
	NoNewPrivileges     bool     `json:"noNewPrivileges"`
	SeccompMode         int      `json:"seccompMode"`
	CoreSoftBytes       uint64   `json:"coreSoftBytes"`
	CoreHardBytes       uint64   `json:"coreHardBytes"`
}

type LimitReadiness struct {
	CgroupVersion      int    `json:"cgroupVersion"`
	PidsMax            int64  `json:"pidsMax"`
	MemoryMaxBytes     int64  `json:"memoryMaxBytes"`
	MemorySwapMaxBytes int64  `json:"memorySwapMaxBytes"`
	CPUQuotaMicros     int64  `json:"cpuQuotaMicros"`
	CPUPeriodMicros    int64  `json:"cpuPeriodMicros"`
	ImageDeviceMajor   int    `json:"imageDeviceMajor"`
	ImageDeviceMinor   int    `json:"imageDeviceMinor"`
	ImageReadBPS       int64  `json:"imageReadBytesPerSecond"`
	ImageReadIOPS      int64  `json:"imageReadOperationsPerSecond"`
	OpenFilesSoft      uint64 `json:"openFilesSoft"`
	OpenFilesHard      uint64 `json:"openFilesHard"`
	UserProcessesSoft  uint64 `json:"userProcessesSoft"`
	UserProcessesHard  uint64 `json:"userProcessesHard"`
	FileSizeSoftBytes  uint64 `json:"fileSizeSoftBytes"`
	FileSizeHardBytes  uint64 `json:"fileSizeHardBytes"`
}

type FilesystemControl struct {
	Type   string `json:"type"`
	Bytes  int64  `json:"bytes"`
	Inodes int64  `json:"inodes"`
	Mode   int    `json:"mode"`
	Nosuid bool   `json:"nosuid"`
	Nodev  bool   `json:"nodev"`
	Noexec bool   `json:"noexec"`
}

type FilesystemReadiness struct {
	RootReadOnly      bool              `json:"rootReadOnly"`
	Workspace         FilesystemControl `json:"workspace"`
	NodeRuntime       FilesystemControl `json:"nodeRuntime"`
	SupervisorRuntime FilesystemControl `json:"supervisorRuntime"`
}

type NetworkReadiness struct {
	Namespace  string   `json:"namespace"`
	Interfaces []string `json:"interfaces"`
	Routes     []string `json:"routes"`
}

type SystemFileReadiness struct {
	Hostname string   `json:"hostname"`
	Hosts    []string `json:"hosts"`
	Resolver []string `json:"resolver"`
}

type StreamReadiness struct {
	StdinAttached  bool `json:"stdinAttached"`
	StdoutAttached bool `json:"stdoutAttached"`
	StderrAttached bool `json:"stderrAttached"`
	TTY            bool `json:"tty"`
}

type ReadinessMeasurement struct {
	Process     ProcessReadiness    `json:"process"`
	Limits      LimitReadiness      `json:"limits"`
	Filesystems FilesystemReadiness `json:"filesystems"`
	Network     NetworkReadiness    `json:"network"`
	SystemFiles SystemFileReadiness `json:"systemFiles"`
	Streams     StreamReadiness     `json:"streams"`
	LogDriver   string              `json:"logDriver"`
	Healthcheck string              `json:"healthcheck"`
}

type Readiness struct {
	Version        int    `json:"version"`
	ContainerID    string `json:"containerId"`
	TrialID        string `json:"trialId"`
	IdentityDigest string `json:"identityDigest"`
	ImageID        string `json:"imageId"`
	PolicyDigest   string `json:"policyDigest"`
	ReadinessMeasurement
}

func BuildReadiness(
	challenge containerprotocol.ReadinessChallenge,
	measurement ReadinessMeasurement,
) ([]byte, error) {
	expected := expectedReadinessMeasurement(challenge.ImageDeviceMajor, challenge.ImageDeviceMinor)
	if !reflect.DeepEqual(measurement.Process, expected.Process) {
		return nil, errors.New("Prime effective process controls contradict the fixed runtime policy")
	}
	if measurement.Limits != expected.Limits {
		return nil, errors.New("Prime effective resource limits contradict the fixed runtime policy")
	}
	if measurement.Filesystems != expected.Filesystems {
		return nil, errors.New("Prime effective filesystem controls contradict the fixed runtime policy")
	}
	if !reflect.DeepEqual(measurement.Network, expected.Network) {
		return nil, errors.New("Prime effective network controls contradict the fixed runtime policy")
	}
	if !reflect.DeepEqual(measurement.SystemFiles, expected.SystemFiles) {
		return nil, errors.New("Prime effective system files contradict the fixed runtime policy")
	}
	if measurement.Streams != expected.Streams {
		return nil, errors.New("Prime effective stream controls contradict the fixed runtime policy")
	}
	if measurement.LogDriver != expected.LogDriver {
		return nil, errors.New("Prime effective log policy contradicts the fixed runtime policy")
	}
	if measurement.Healthcheck != expected.Healthcheck {
		return nil, errors.New("Prime effective health policy contradicts the fixed runtime policy")
	}
	payload, err := json.Marshal(Readiness{
		Version: challenge.Version, ContainerID: challenge.ContainerID, TrialID: challenge.TrialID,
		IdentityDigest: challenge.IdentityDigest, ImageID: challenge.ImageID,
		PolicyDigest: challenge.PolicyDigest, ReadinessMeasurement: measurement,
	})
	if err != nil || len(payload) > containerprotocol.MaxPayloadBytes {
		return nil, errors.New("Prime readiness cannot be encoded within its byte limit")
	}
	return payload, nil
}

func expectedReadinessMeasurement(imageDeviceMajor int, imageDeviceMinor int) ReadinessMeasurement {
	return ReadinessMeasurement{
		Process: ProcessReadiness{
			SupervisorPID: 1, SupervisorUID: 0, NodeUID: NodeUID, PythonUID: PythonUID, SharedGID: SharedGID,
			SupplementaryGroups: []int{SharedGID},
			Capabilities:        []string{"CHOWN", "DAC_READ_SEARCH", "FOWNER", "KILL", "SETGID", "SETUID"},
			Dumpable:            false, NoNewPrivileges: true, SeccompMode: 2,
			CoreSoftBytes: 0, CoreHardBytes: 0,
		},
		Limits: LimitReadiness{
			CgroupVersion: 2, PidsMax: 64, MemoryMaxBytes: 2147483648, MemorySwapMaxBytes: 0,
			CPUQuotaMicros: 200000, CPUPeriodMicros: 100000,
			ImageDeviceMajor: imageDeviceMajor, ImageDeviceMinor: imageDeviceMinor,
			ImageReadBPS: 67108864, ImageReadIOPS: 4096,
			OpenFilesSoft: 256, OpenFilesHard: 256,
			UserProcessesSoft: 64, UserProcessesHard: 64,
			FileSizeSoftBytes: 268435456, FileSizeHardBytes: 268435456,
		},
		Filesystems: FilesystemReadiness{
			RootReadOnly:      true,
			Workspace:         fixedFilesystemControl(536870912, 8192, 0710),
			NodeRuntime:       fixedFilesystemControl(16777216, 256, 0700),
			SupervisorRuntime: fixedFilesystemControl(16777216, 256, 0700),
		},
		Network: NetworkReadiness{Namespace: "private", Interfaces: []string{"lo"}, Routes: []string{}},
		SystemFiles: SystemFileReadiness{
			Hostname: "flow-prime",
			Hosts:    []string{"127.0.0.1 localhost flow-prime", "::1 localhost ip6-localhost ip6-loopback"},
			Resolver: []string{"nameserver 127.0.0.1", "search .", "options ndots:0"},
		},
		Streams: StreamReadiness{
			StdinAttached: true, StdoutAttached: true, StderrAttached: true, TTY: false,
		},
		LogDriver: "none", Healthcheck: "none",
	}
}

func fixedFilesystemControl(bytes int64, inodes int64, mode int) FilesystemControl {
	return FilesystemControl{
		Type: "tmpfs", Bytes: bytes, Inodes: inodes, Mode: mode,
		Nosuid: true, Nodev: true, Noexec: true,
	}
}
