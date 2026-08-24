//go:build linux

package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const (
	expectedEffectiveCapabilities = uint64(1<<5 | 1<<7) // CAP_KILL | CAP_SETUID
	expectedMemoryMaxBytes        = "4294967296"
	expectedMemorySwapMaxBytes    = "0"
	expectedPidsMax               = "128"
	expectedCPUQuota              = "200000 100000"
	linuxRlimitNproc              = 6 // RLIMIT_NPROC from the Linux userspace ABI.
)

func verifyRuntimeContainment() error {
	if os.Getpid() != 1 || os.Geteuid() != 0 || os.Getegid() != proofGID {
		return errors.New("supervisor process identity is not isolated root PID 1")
	}
	if os.Getenv("HOME") != "/workspace/home" {
		return errors.New("supervisor HOME is not isolated")
	}
	if err := rejectCredentialEnvironment(); err != nil {
		return err
	}
	if err := verifyProcessStatus(); err != nil {
		return err
	}
	if err := verifyResourceLimits(); err != nil {
		return err
	}
	if err := verifyMountPolicy(); err != nil {
		return err
	}
	if err := verifyCgroupV2Policy(); err != nil {
		return err
	}
	return verifyNetworkNamespace()
}

func rejectCredentialEnvironment() error {
	for _, item := range os.Environ() {
		name := strings.ToUpper(strings.SplitN(item, "=", 2)[0])
		for _, marker := range []string{
			"TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY", "PRIVATE_KEY",
			"AWS_", "AZURE_", "GOOGLE_", "GITHUB_",
		} {
			if strings.Contains(name, marker) {
				return errors.New("credential-like environment variable is present")
			}
		}
	}
	return nil
}

func verifyProcessStatus() error {
	status, err := readKeyValueFile("/proc/self/status")
	if err != nil {
		return err
	}
	if status["NoNewPrivs"] != "1" || status["Seccomp"] != "2" {
		return errors.New("no-new-privileges or seccomp enforcement is missing")
	}
	capabilities, err := strconv.ParseUint(status["CapEff"], 16, 64)
	if err != nil || capabilities != expectedEffectiveCapabilities {
		return errors.New("effective capability set is not exactly CAP_KILL and CAP_SETUID")
	}
	uidFields := strings.Fields(status["Uid"])
	gidFields := strings.Fields(status["Gid"])
	if len(uidFields) != 4 || len(gidFields) != 4 {
		return errors.New("process credential status is malformed")
	}
	for _, value := range uidFields {
		if value != "0" {
			return errors.New("supervisor user credentials are inconsistent")
		}
	}
	for _, value := range gidFields {
		if value != strconv.Itoa(proofGID) {
			return errors.New("supervisor group credentials are inconsistent")
		}
	}
	return nil
}

func verifyResourceLimits() error {
	for _, expected := range []struct {
		resource int
		value    uint64
	}{
		{syscall.RLIMIT_NOFILE, 512},
		{linuxRlimitNproc, 128},
		{syscall.RLIMIT_FSIZE, 268435456},
		{syscall.RLIMIT_CORE, 0},
	} {
		var limit syscall.Rlimit
		if err := syscall.Getrlimit(expected.resource, &limit); err != nil {
			return err
		}
		if limit.Cur != expected.value || limit.Max != expected.value {
			return errors.New("effective process resource limits do not match the proof profile")
		}
	}
	return nil
}

func verifyMountPolicy() error {
	file, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return err
	}
	defer file.Close()
	foundRoot := false
	foundWorkspace := false
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 6 {
			return errors.New("mountinfo is malformed")
		}
		switch fields[4] {
		case "/":
			foundRoot = optionSet(fields[5], "ro")
		case "/workspace":
			foundWorkspace = optionSet(fields[5], "rw") && optionSet(fields[5], "nosuid") &&
				optionSet(fields[5], "nodev") && optionSet(fields[5], "noexec")
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if !foundRoot || !foundWorkspace {
		return errors.New("root or proof workspace mount policy is not effective")
	}
	return nil
}

func verifyCgroupV2Policy() error {
	cgroup, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return err
	}
	var relative string
	for _, line := range strings.Split(strings.TrimSpace(string(cgroup)), "\n") {
		if strings.HasPrefix(line, "0::") {
			relative = strings.TrimPrefix(line, "0::")
			break
		}
	}
	if relative == "" || !filepath.IsAbs(relative) || strings.Contains(relative, "..") {
		return errors.New("private cgroup v2 identity is unavailable")
	}
	root := filepath.Join("/sys/fs/cgroup", relative)
	for name, expected := range map[string]string{
		"memory.max":      expectedMemoryMaxBytes,
		"memory.swap.max": expectedMemorySwapMaxBytes,
		"pids.max":        expectedPidsMax,
		"cpu.max":         expectedCPUQuota,
	} {
		value, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || strings.TrimSpace(string(value)) != expected {
			return fmt.Errorf("effective cgroup limit %s does not match the proof profile", name)
		}
	}
	return nil
}

func verifyNetworkNamespace() error {
	file, err := os.Open("/proc/net/dev")
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		separator := strings.IndexByte(line, ':')
		if separator < 0 {
			continue
		}
		if strings.TrimSpace(line[:separator]) != "lo" {
			return errors.New("network namespace contains a non-loopback interface")
		}
	}
	return scanner.Err()
}

func readKeyValueFile(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	values := map[string]string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		key, value, found := strings.Cut(scanner.Text(), ":")
		if found {
			values[key] = strings.TrimSpace(value)
		}
	}
	return values, scanner.Err()
}

func optionSet(options string, expected string) bool {
	for _, option := range strings.Split(options, ",") {
		if option == expected {
			return true
		}
	}
	return false
}
