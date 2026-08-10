package supervisor

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

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

func parseMountInfo(source string) (map[string]mountInformation, error) {
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
