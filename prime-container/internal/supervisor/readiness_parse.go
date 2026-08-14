package supervisor

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxDockerSystemFileBytes   = 4096
	maxNetworkInformationBytes = 65536
	fixedDockerHostname        = "flow-prime\n"
	fixedDockerHostsSource     = "127.0.0.1\tlocalhost\n" +
		"::1\tlocalhost ip6-localhost ip6-loopback\n" +
		"fe00::\tip6-localnet\n" +
		"ff00::\tip6-mcastprefix\n" +
		"ff02::1\tip6-allnodes\n" +
		"ff02::2\tip6-allrouters\n"
)

func parseNetworkInterfaces(source string) ([]string, error) {
	invalid := func() ([]string, error) {
		return nil, errors.New("Prime network interface information is invalid")
	}
	if len(source) > maxNetworkInformationBytes || !utf8.ValidString(source) || strings.ContainsRune(source, '\r') {
		return invalid()
	}
	lines := strings.Split(strings.TrimSuffix(source, "\n"), "\n")
	if len(lines) < 3 || strings.Join(strings.Fields(lines[0]), " ") != "Inter-| Receive | Transmit" ||
		strings.Join(strings.Fields(lines[1]), " ") != "face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed" {
		return invalid()
	}
	names := make([]string, 0, len(lines)-2)
	seen := make(map[string]bool, len(lines)-2)
	for _, line := range lines[2:] {
		nameSource, counterSource, found := strings.Cut(line, ":")
		name := strings.TrimSpace(nameSource)
		if !found || strings.Contains(counterSource, ":") || !isNetworkInterfaceName(name) || seen[name] {
			return invalid()
		}
		counters := strings.Fields(counterSource)
		if len(counters) != 16 {
			return invalid()
		}
		for _, counter := range counters {
			if _, err := strconv.ParseUint(counter, 10, 64); err != nil {
				return invalid()
			}
		}
		seen[name] = true
		names = append(names, name)
	}
	if len(names) == 0 {
		return invalid()
	}
	sort.Strings(names)
	return names, nil
}

func isNetworkInterfaceName(value string) bool {
	if len(value) < 1 || len(value) > 15 {
		return false
	}
	for _, character := range []byte(value) {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '_' && character != '.' && character != '-' {
			return false
		}
	}
	return true
}

func measureNetworkWith(read func(string, int) ([]byte, error)) (NetworkReadiness, error) {
	interfaceSource, err := read("/proc/net/dev", maxNetworkInformationBytes)
	if err != nil {
		return NetworkReadiness{}, fmt.Errorf("inspect Prime network interfaces: %w", err)
	}
	names, err := parseNetworkInterfaces(string(interfaceSource))
	if err != nil {
		return NetworkReadiness{}, fmt.Errorf("inspect Prime network interfaces: %w", err)
	}
	routeSource, err := read("/proc/net/route", maxNetworkInformationBytes)
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

func readBoundedProcFile(path string, limit int) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(content) > limit {
		return nil, errors.New("Prime proc file exceeds its byte limit")
	}
	return content, nil
}

var (
	fixedDockerHosts = []string{
		"127.0.0.1 localhost",
		"::1 localhost ip6-localhost ip6-loopback",
		"fe00:: ip6-localnet",
		"ff00:: ip6-mcastprefix",
		"ff02::1 ip6-allnodes",
		"ff02::2 ip6-allrouters",
	}
	fixedDockerResolver        = []string{"nameserver 127.0.0.1", "options ndots:0"}
	dockerSystemFileMountPaths = []string{"/etc/hostname", "/etc/hosts", "/etc/resolv.conf"}
)

type dockerSystemFile interface {
	io.Reader
	Close() error
	information() (os.FileMode, int64, uint32, uint32, error)
}

type kernelStatus struct {
	Groups          []int
	Capabilities    []string
	NoNewPrivileges bool
	SeccompMode     int
}

type mountInformation struct {
	Filesystem   string
	Options      map[string]bool
	SuperOptions map[string]bool
}

var capabilityNames = map[int]string{
	0: "CHOWN", 1: "DAC_OVERRIDE", 2: "DAC_READ_SEARCH", 3: "FOWNER", 4: "FSETID",
	5: "KILL", 6: "SETGID", 7: "SETUID", 8: "SETPCAP", 9: "LINUX_IMMUTABLE",
	10: "NET_BIND_SERVICE", 11: "NET_BROADCAST", 12: "NET_ADMIN", 13: "NET_RAW",
	14: "IPC_LOCK", 15: "IPC_OWNER", 16: "SYS_MODULE", 17: "SYS_RAWIO", 18: "SYS_CHROOT",
	19: "SYS_PTRACE", 20: "SYS_PACCT", 21: "SYS_ADMIN", 22: "SYS_BOOT", 23: "SYS_NICE",
	24: "SYS_RESOURCE", 25: "SYS_TIME", 26: "SYS_TTY_CONFIG", 27: "MKNOD", 28: "LEASE",
	29: "AUDIT_WRITE", 30: "AUDIT_CONTROL", 31: "SETFCAP", 32: "MAC_OVERRIDE",
	33: "MAC_ADMIN", 34: "SYSLOG", 35: "WAKE_ALARM", 36: "BLOCK_SUSPEND",
	37: "AUDIT_READ", 38: "PERFMON", 39: "BPF", 40: "CHECKPOINT_RESTORE",
}

func parseDockerHostname(source []byte) (string, error) {
	if !bytes.Equal(source, []byte(fixedDockerHostname)) {
		return "", errors.New("Docker hostname contradicts the admitted content")
	}
	return "flow-prime", nil
}

func validateDockerSystemFileInformation(mode os.FileMode, size int64, uid uint32, gid uint32) error {
	if !mode.IsRegular() || size < 0 || size > maxDockerSystemFileBytes ||
		uid != 0 || gid != 0 || mode.Perm()&0022 != 0 {
		return errors.New("Docker system file is not one protected root-owned regular file")
	}
	return nil
}

func readDockerSystemFileWith(
	path string,
	open func(string) (dockerSystemFile, error),
) ([]byte, error) {
	file, err := open(path)
	if err != nil {
		return nil, fmt.Errorf("open Docker system file %s: %w", path, err)
	}
	defer file.Close()
	mode, size, uid, gid, err := file.information()
	if err != nil {
		return nil, fmt.Errorf("inspect Docker system file %s: %w", path, err)
	}
	if err := validateDockerSystemFileInformation(mode, size, uid, gid); err != nil {
		return nil, fmt.Errorf("inspect Docker system file %s: invalid protected inode", path)
	}
	content, err := io.ReadAll(io.LimitReader(file, maxDockerSystemFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Docker system file %s: %w", path, err)
	}
	if len(content) > maxDockerSystemFileBytes {
		return nil, fmt.Errorf("read Docker system file %s: content exceeds its byte limit", path)
	}
	return content, nil
}

func parseDockerHosts(source []byte) ([]string, error) {
	if !bytes.Equal(source, []byte(fixedDockerHostsSource)) {
		return nil, errors.New("Docker hosts file contradicts the admitted content")
	}
	return append([]string(nil), fixedDockerHosts...), nil
}

func parseDockerResolver(source []byte) ([]string, error) {
	if len(source) > maxDockerSystemFileBytes || !utf8.Valid(source) || bytes.ContainsRune(source, '\r') {
		return nil, errors.New("Docker resolver file contradicts the admitted content")
	}
	lines := strings.Split(string(source), "\n")
	if len(lines) != 11 || lines[10] != "" || !reflectDockerResolverHeader(lines[:3]) ||
		lines[3] != "" || lines[4] != fixedDockerResolver[0] || lines[5] != fixedDockerResolver[1] ||
		lines[6] != "" || !isAdmittedDockerResolverOrigin(lines[7]) ||
		lines[8] != "# Overrides: [nameservers search options]" ||
		lines[9] != "# Option ndots from: override" {
		return nil, errors.New("Docker resolver file contradicts the admitted content")
	}
	return append([]string(nil), fixedDockerResolver...), nil
}

func reflectDockerResolverHeader(lines []string) bool {
	return len(lines) == 3 &&
		lines[0] == "# Generated by Docker Engine." &&
		lines[1] == "# This file can be edited; Docker Engine will not make further changes once it" &&
		lines[2] == "# has been modified."
}

func isAdmittedDockerResolverOrigin(line string) bool {
	return line == "# Based on host file: '/etc/resolv.conf' (legacy)" ||
		line == "# Based on host file: '/run/systemd/resolve/resolv.conf' (legacy)"
}

func verifyDockerSystemFileMounts(mounts map[string]mountInformation) error {
	for _, path := range []string{"/etc/hostname", "/etc/hosts", "/etc/resolv.conf"} {
		mount, found := mounts[path]
		if !found || !mount.Options["ro"] {
			return errors.New("Docker system files are not three read-only mounts")
		}
	}
	return nil
}

func measureSystemFilesWith(
	readMountInformation func() ([]byte, error),
	readSystemFile func(string) ([]byte, error),
) (SystemFileReadiness, error) {
	mountSource, err := readMountInformation()
	if err != nil {
		return SystemFileReadiness{}, fmt.Errorf("read Docker system file mount information: %w", err)
	}
	mounts, err := parseSelectedMountInfo(string(mountSource), dockerSystemFileMountPaths)
	if err != nil {
		return SystemFileReadiness{}, fmt.Errorf("parse Docker system file mount information: %w", err)
	}
	if err := verifyDockerSystemFileMounts(mounts); err != nil {
		return SystemFileReadiness{}, err
	}
	hostnameSource, err := readSystemFile("/etc/hostname")
	if err != nil {
		return SystemFileReadiness{}, err
	}
	hostname, err := parseDockerHostname(hostnameSource)
	if err != nil {
		return SystemFileReadiness{}, err
	}
	hostsSource, err := readSystemFile("/etc/hosts")
	if err != nil {
		return SystemFileReadiness{}, err
	}
	hosts, err := parseDockerHosts(hostsSource)
	if err != nil {
		return SystemFileReadiness{}, err
	}
	resolverSource, err := readSystemFile("/etc/resolv.conf")
	if err != nil {
		return SystemFileReadiness{}, err
	}
	resolver, err := parseDockerResolver(resolverSource)
	if err != nil {
		return SystemFileReadiness{}, err
	}
	return SystemFileReadiness{Hostname: hostname, Hosts: hosts, Resolver: resolver}, nil
}

func parseKernelStatus(source string) (kernelStatus, error) {
	values := make(map[string]string)
	for _, line := range strings.Split(source, "\n") {
		name, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		if _, exists := values[name]; exists {
			return kernelStatus{}, fmt.Errorf("Linux process status repeats %s", name)
		}
		values[name] = strings.TrimSpace(value)
	}
	for _, required := range []string{"Groups", "CapEff", "NoNewPrivs", "Seccomp"} {
		if _, found := values[required]; !found {
			return kernelStatus{}, fmt.Errorf("Linux process status omits %s", required)
		}
	}
	groups := make([]int, 0)
	for _, value := range strings.Fields(values["Groups"]) {
		group, err := strconv.ParseInt(value, 10, 32)
		if err != nil || group < 0 {
			return kernelStatus{}, errors.New("Linux process group list is invalid")
		}
		groups = append(groups, int(group))
	}
	bits, err := strconv.ParseUint(values["CapEff"], 16, 64)
	if err != nil {
		return kernelStatus{}, errors.New("Linux effective capability set is invalid")
	}
	capabilities := make([]string, 0)
	for bit := 0; bit < 64; bit++ {
		if bits&(uint64(1)<<bit) == 0 {
			continue
		}
		name, found := capabilityNames[bit]
		if !found {
			return kernelStatus{}, fmt.Errorf("Linux effective capability bit %d is unknown", bit)
		}
		capabilities = append(capabilities, name)
	}
	noNewPrivileges, err := strconv.Atoi(values["NoNewPrivs"])
	if err != nil || (noNewPrivileges != 0 && noNewPrivileges != 1) {
		return kernelStatus{}, errors.New("Linux no-new-privileges value is invalid")
	}
	seccomp, err := strconv.Atoi(values["Seccomp"])
	if err != nil || seccomp < 0 || seccomp > 2 {
		return kernelStatus{}, errors.New("Linux seccomp mode is invalid")
	}
	return kernelStatus{
		Groups: groups, Capabilities: capabilities,
		NoNewPrivileges: noNewPrivileges == 1, SeccompMode: seccomp,
	}, nil
}

func parseBoundedCgroupInteger(source string, label string) (int64, error) {
	value := strings.TrimSpace(source)
	if value == "" || value == "max" {
		return 0, fmt.Errorf("Prime cgroup %s is not one finite value", label)
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 {
		return 0, fmt.Errorf("Prime cgroup %s is invalid", label)
	}
	return parsed, nil
}

func parseCPUControl(source string) (int64, int64, error) {
	fields := strings.Fields(source)
	if len(fields) != 2 {
		return 0, 0, errors.New("Prime cgroup cpu.max is invalid")
	}
	quota, err := parseBoundedCgroupInteger(fields[0], "cpu.max quota")
	if err != nil {
		return 0, 0, err
	}
	period, err := parseBoundedCgroupInteger(fields[1], "cpu.max period")
	if err != nil || period < 1 {
		return 0, 0, errors.New("Prime cgroup cpu.max period is invalid")
	}
	return quota, period, nil
}

func parseSelectedMountInfo(source string, selectedMountPoints []string) (map[string]mountInformation, error) {
	selected := make(map[string]bool, len(selectedMountPoints))
	for _, mountPoint := range selectedMountPoints {
		selected[mountPoint] = true
	}
	mounts := make(map[string]mountInformation)
	for lineNumber, line := range strings.Split(strings.TrimSpace(source), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Fields(line)
		separator := -1
		for index, field := range fields {
			if field == "-" {
				separator = index
				break
			}
		}
		if len(fields) < 10 || separator < 6 || separator+3 >= len(fields) {
			return nil, fmt.Errorf("Linux mount information line %d is invalid", lineNumber+1)
		}
		mountPoint := unescapeMountPath(fields[4])
		if !selected[mountPoint] {
			continue
		}
		if _, exists := mounts[mountPoint]; exists {
			return nil, fmt.Errorf("Linux mount information repeats %s", mountPoint)
		}
		mounts[mountPoint] = mountInformation{
			Filesystem:   fields[separator+1],
			Options:      splitOptions(fields[5]),
			SuperOptions: splitOptions(fields[separator+3]),
		}
	}
	return mounts, nil
}

func splitOptions(source string) map[string]bool {
	options := make(map[string]bool)
	for _, option := range strings.Split(source, ",") {
		name, _, _ := strings.Cut(option, "=")
		options[name] = true
	}
	return options
}

func unescapeMountPath(value string) string {
	replacer := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	return replacer.Replace(value)
}
