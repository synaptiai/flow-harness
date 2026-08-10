//go:build linux

package supervisor

import (
	"errors"
	"fmt"
	"net"
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
	core := syscall.Rlimit{Cur: 0, Max: 0}
	if err := syscall.Setrlimit(syscall.RLIMIT_CORE, &core); err != nil {
		return fmt.Errorf("set Prime supervisor core limit: %w", err)
	}
	if _, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, prSetDumpable, 0, 0, 0, 0, 0); errno != 0 {
		return fmt.Errorf("disable Prime supervisor dumpable state: %w", errno)
	}
	return nil
}

func MeasureReadiness() (ReadinessMeasurement, error) {
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
	limits, err := measureLimits()
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
	return ReadinessMeasurement{
		Process: ProcessReadiness{
			SupervisorUID: os.Geteuid(), NodeUID: NodeUID, PythonUID: PythonUID, SharedGID: SharedGID,
			SupplementaryGroups: groups, Capabilities: status.Capabilities,
			Dumpable: dumpable != 0, NoNewPrivileges: status.NoNewPrivileges,
			SeccompMode: int(seccomp), CoreSoftBytes: limitsCore.Cur, CoreHardBytes: limitsCore.Max,
		},
		Limits:      limits,
		Filesystems: filesystems,
		Network:     network,
		Streams: StreamReadiness{
			StdinAttached: descriptorExists(0), StdoutAttached: descriptorExists(1),
			StderrAttached: descriptorExists(2), TTY: descriptorIsTTY(0) || descriptorIsTTY(1) || descriptorIsTTY(2),
		},
		LogDriver: "none", Healthcheck: "none",
	}, nil
}

var limitsCore syscall.Rlimit

func measureLimits() (LimitReadiness, error) {
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
		OpenFilesSoft: nofile.Cur, OpenFilesHard: nofile.Max,
		UserProcessesSoft: nproc.Cur, UserProcessesHard: nproc.Max,
		FileSizeSoftBytes: fsize.Cur, FileSizeHardBytes: fsize.Max,
	}, nil
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
	mounts, err := parseMountInfo(string(source))
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
	interfaces, err := net.Interfaces()
	if err != nil {
		return NetworkReadiness{}, fmt.Errorf("inspect Prime network interfaces: %w", err)
	}
	names := make([]string, 0, len(interfaces))
	for _, item := range interfaces {
		names = append(names, item.Name)
	}
	sort.Strings(names)
	routeSource, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return NetworkReadiness{}, fmt.Errorf("inspect Prime network routes: %w", err)
	}
	routes := make([]string, 0)
	for index, line := range strings.Split(strings.TrimSpace(string(routeSource)), "\n") {
		if index == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		routes = append(routes, strings.Fields(line)[0])
	}
	return NetworkReadiness{Namespace: "private", Interfaces: names, Routes: routes}, nil
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
