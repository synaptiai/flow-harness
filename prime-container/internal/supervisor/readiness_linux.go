//go:build linux

package supervisor

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	prGetDumpable = 3
	prSetDumpable = 4
	prGetSeccomp  = 21
	rlimitNproc   = 6
)

func HardenSupervisor() error {
	return hardenSupervisorWith(
		func() error {
			core := syscall.Rlimit{Cur: 0, Max: 0}
			return syscall.Setrlimit(syscall.RLIMIT_CORE, &core)
		},
		func() error {
			_, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, prSetDumpable, 0, 0, 0, 0, 0)
			if errno != 0 {
				return errno
			}
			return nil
		},
	)
}

func MeasureReadiness(imageDeviceMajor int, imageDeviceMinor int) (ReadinessMeasurement, error) {
	statusSource, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return ReadinessMeasurement{}, fmt.Errorf("read Prime process status: %w", err)
	}
	status, err := parseKernelStatus(string(statusSource))
	if err != nil {
		return ReadinessMeasurement{}, err
	}
	groups := append([]int(nil), status.Groups...)
	if !containsInteger(groups, os.Getegid()) {
		groups = append(groups, os.Getegid())
	}
	sort.Ints(groups)
	dumpable, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, prGetDumpable, 0, 0, 0, 0, 0)
	if errno != 0 {
		return ReadinessMeasurement{}, fmt.Errorf("read Prime dumpable state: %w", errno)
	}
	seccomp, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, prGetSeccomp, 0, 0, 0, 0, 0)
	if errno != 0 {
		return ReadinessMeasurement{}, fmt.Errorf("read Prime seccomp state: %w", errno)
	}
	limits, err := measureLimits(imageDeviceMajor, imageDeviceMinor)
	if err != nil {
		return ReadinessMeasurement{}, err
	}
	filesystems, err := measureFilesystems()
	if err != nil {
		return ReadinessMeasurement{}, err
	}
	network, err := measureNetwork()
	if err != nil {
		return ReadinessMeasurement{}, err
	}
	systemFiles, err := measureSystemFiles()
	if err != nil {
		return ReadinessMeasurement{}, err
	}
	return ReadinessMeasurement{
		Process: ProcessReadiness{
			SupervisorPID: os.Getpid(), SupervisorUID: os.Geteuid(),
			NodeUID: NodeUID, PythonUID: PythonUID, SharedGID: SharedGID,
			SupplementaryGroups: groups, Capabilities: status.Capabilities,
			Dumpable: dumpable != 0, NoNewPrivileges: status.NoNewPrivileges,
			SeccompMode: int(seccomp), CoreSoftBytes: limitsCore.Cur, CoreHardBytes: limitsCore.Max,
		},
		Limits:      limits,
		Filesystems: filesystems,
		Network:     network,
		SystemFiles: systemFiles,
		Streams: StreamReadiness{
			StdinAttached: descriptorExists(0), StdoutAttached: descriptorExists(1),
			StderrAttached: descriptorExists(2), TTY: descriptorIsTTY(0) || descriptorIsTTY(1) || descriptorIsTTY(2),
		},
		LogDriver: "none", Healthcheck: "none",
	}, nil
}

func measureSystemFiles() (SystemFileReadiness, error) {
	return measureSystemFilesWith(
		func() ([]byte, error) { return os.ReadFile("/proc/self/mountinfo") },
		readDockerSystemFile,
	)
}

func readDockerSystemFile(path string) ([]byte, error) {
	return readDockerSystemFileWith(path, func(path string) (dockerSystemFile, error) {
		descriptor, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return nil, err
		}
		return &linuxDockerSystemFile{File: os.NewFile(uintptr(descriptor), path)}, nil
	})
}

type linuxDockerSystemFile struct{ *os.File }

func (file *linuxDockerSystemFile) information() (os.FileMode, int64, uint32, uint32, error) {
	information, err := file.Stat()
	if err != nil {
		return 0, 0, 0, 0, err
	}
	stat, ok := information.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, 0, 0, errors.New("Docker system file does not have Linux inode metadata")
	}
	return information.Mode(), information.Size(), stat.Uid, stat.Gid, nil
}

var limitsCore syscall.Rlimit

func measureLimits(imageDeviceMajor int, imageDeviceMinor int) (LimitReadiness, error) {
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err != nil {
		return LimitReadiness{}, errors.New("Prime runtime does not use cgroup version two")
	}
	pids, err := readCgroupInteger("pids.max")
	if err != nil {
		return LimitReadiness{}, err
	}
	memory, err := readCgroupInteger("memory.max")
	if err != nil {
		return LimitReadiness{}, err
	}
	swap, err := readCgroupInteger("memory.swap.max")
	if err != nil {
		return LimitReadiness{}, err
	}
	cpuSource, err := os.ReadFile("/sys/fs/cgroup/cpu.max")
	if err != nil {
		return LimitReadiness{}, fmt.Errorf("read Prime cgroup cpu.max: %w", err)
	}
	quota, period, err := parseCPUControl(string(cpuSource))
	if err != nil {
		return LimitReadiness{}, err
	}
	readBPS, readIOPS, err := readIOControl(imageDeviceMajor, imageDeviceMinor)
	if err != nil {
		return LimitReadiness{}, err
	}
	nofile, err := getRlimit(syscall.RLIMIT_NOFILE, "open files")
	if err != nil {
		return LimitReadiness{}, err
	}
	nproc, err := getRlimit(rlimitNproc, "user processes")
	if err != nil {
		return LimitReadiness{}, err
	}
	fsize, err := getRlimit(syscall.RLIMIT_FSIZE, "file size")
	if err != nil {
		return LimitReadiness{}, err
	}
	core, err := getRlimit(syscall.RLIMIT_CORE, "core size")
	if err != nil {
		return LimitReadiness{}, err
	}
	limitsCore = core
	return LimitReadiness{
		CgroupVersion: 2, PidsMax: pids, MemoryMaxBytes: memory, MemorySwapMaxBytes: swap,
		CPUQuotaMicros: quota, CPUPeriodMicros: period,
		ImageDeviceMajor: imageDeviceMajor, ImageDeviceMinor: imageDeviceMinor,
		ImageReadBPS: readBPS, ImageReadIOPS: readIOPS,
		OpenFilesSoft: nofile.Cur, OpenFilesHard: nofile.Max,
		UserProcessesSoft: nproc.Cur, UserProcessesHard: nproc.Max,
		FileSizeSoftBytes: fsize.Cur, FileSizeHardBytes: fsize.Max,
	}, nil
}

func readIOControl(major int, minor int) (int64, int64, error) {
	source, err := os.ReadFile("/sys/fs/cgroup/io.max")
	if err != nil {
		return 0, 0, fmt.Errorf("read Prime cgroup io.max: %w", err)
	}
	target := fmt.Sprintf("%d:%d", major, minor)
	for _, line := range strings.Split(strings.TrimSpace(string(source)), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != target {
			continue
		}
		values := map[string]int64{}
		for _, field := range fields[1:] {
			parts := strings.SplitN(field, "=", 2)
			if len(parts) != 2 || (parts[0] != "rbps" && parts[0] != "riops") {
				continue
			}
			value, parseErr := strconv.ParseInt(parts[1], 10, 64)
			if parseErr != nil || value < 0 {
				return 0, 0, errors.New("Prime cgroup io.max contains an invalid read limit")
			}
			if _, exists := values[parts[0]]; exists {
				return 0, 0, errors.New("Prime cgroup io.max contains a duplicate read limit")
			}
			values[parts[0]] = value
		}
		readBPS, hasBPS := values["rbps"]
		readIOPS, hasIOPS := values["riops"]
		if !hasBPS || !hasIOPS {
			return 0, 0, errors.New("Prime cgroup io.max omits an admitted read limit")
		}
		return readBPS, readIOPS, nil
	}
	return 0, 0, errors.New("Prime cgroup io.max omits the admitted image device")
}

func readCgroupInteger(name string) (int64, error) {
	source, err := os.ReadFile("/sys/fs/cgroup/" + name)
	if err != nil {
		return 0, fmt.Errorf("read Prime cgroup %s: %w", name, err)
	}
	return parseBoundedCgroupInteger(string(source), name)
}

func getRlimit(resource int, label string) (syscall.Rlimit, error) {
	var limit syscall.Rlimit
	if err := syscall.Getrlimit(resource, &limit); err != nil {
		return syscall.Rlimit{}, fmt.Errorf("read Prime %s limit: %w", label, err)
	}
	return limit, nil
}

func measureFilesystems() (FilesystemReadiness, error) {
	source, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return FilesystemReadiness{}, fmt.Errorf("read Prime mount information: %w", err)
	}
	mounts, err := parseSelectedMountInfo(
		string(source),
		[]string{"/", "/workspace", "/run/flow-node", "/run/flow-supervisor"},
	)
	if err != nil {
		return FilesystemReadiness{}, err
	}
	root, found := mounts["/"]
	if !found {
		return FilesystemReadiness{}, errors.New("Prime root mount is absent")
	}
	workspace, err := measureTmpfs("/workspace", mounts)
	if err != nil {
		return FilesystemReadiness{}, err
	}
	nodeRuntime, err := measureTmpfs("/run/flow-node", mounts)
	if err != nil {
		return FilesystemReadiness{}, err
	}
	supervisorRuntime, err := measureTmpfs("/run/flow-supervisor", mounts)
	if err != nil {
		return FilesystemReadiness{}, err
	}
	return FilesystemReadiness{
		RootReadOnly: root.Options["ro"], Workspace: workspace,
		NodeRuntime: nodeRuntime, SupervisorRuntime: supervisorRuntime,
	}, nil
}

func measureTmpfs(path string, mounts map[string]mountInformation) (FilesystemControl, error) {
	mount, found := mounts[path]
	if !found || mount.Filesystem != "tmpfs" {
		return FilesystemControl{}, fmt.Errorf("Prime runtime path %s is not one exact tmpfs mount", path)
	}
	var filesystem syscall.Statfs_t
	if err := syscall.Statfs(path, &filesystem); err != nil {
		return FilesystemControl{}, fmt.Errorf("inspect Prime tmpfs %s: %w", path, err)
	}
	information, err := os.Stat(path)
	if err != nil || !information.IsDir() {
		return FilesystemControl{}, fmt.Errorf("inspect Prime tmpfs root %s: %w", path, err)
	}
	return FilesystemControl{
		Type: "tmpfs", Bytes: int64(filesystem.Blocks) * filesystem.Bsize,
		Inodes: int64(filesystem.Files), Mode: int(information.Mode().Perm()),
		Nosuid: mount.Options["nosuid"], Nodev: mount.Options["nodev"], Noexec: mount.Options["noexec"],
	}, nil
}

func measureNetwork() (NetworkReadiness, error) {
	return measureNetworkWith(readBoundedProcFile)
}

func descriptorExists(fileDescriptor int) bool {
	var information syscall.Stat_t
	return syscall.Fstat(fileDescriptor, &information) == nil
}

func descriptorIsTTY(fileDescriptor int) bool {
	var termios syscall.Termios
	_, _, errno := syscall.Syscall6(
		syscall.SYS_IOCTL, uintptr(fileDescriptor), uintptr(syscall.TCGETS), uintptr(unsafe.Pointer(&termios)), 0, 0, 0,
	)
	return errno == 0
}

func containsInteger(values []int, expected int) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func parsePositiveInteger(value string) (int64, error) {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed < 0 {
		return 0, errors.New("Prime integer is invalid")
	}
	return parsed, nil
}
