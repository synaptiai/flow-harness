package supervisor

import (
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
)

type fakeDockerSystemFile struct {
	source           []byte
	mode             os.FileMode
	size             int64
	uid              uint32
	gid              uint32
	informationError error
	readError        error
	offset           int
}

func (file *fakeDockerSystemFile) Read(target []byte) (int, error) {
	if file.readError != nil {
		return 0, file.readError
	}
	if file.offset >= len(file.source) {
		return 0, io.EOF
	}
	count := copy(target, file.source[file.offset:])
	file.offset += count
	return count, nil
}

func (*fakeDockerSystemFile) Close() error { return nil }

func (file *fakeDockerSystemFile) information() (os.FileMode, int64, uint32, uint32, error) {
	return file.mode, file.size, file.uid, file.gid, file.informationError
}

func TestParseKernelStatusReadsCapabilitiesAndSecurityState(t *testing.T) {
	status, err := parseKernelStatus("Name:\tflow-prime\nGroups:\t10003 \nCapEff:\t00000000000000ed\nNoNewPrivs:\t1\nSeccomp:\t2\n")
	if err != nil {
		t.Fatalf("parse kernel status: %v", err)
	}
	if !reflect.DeepEqual(status.Groups, []int{10003}) ||
		!reflect.DeepEqual(status.Capabilities, []string{"CHOWN", "DAC_READ_SEARCH", "FOWNER", "KILL", "SETGID", "SETUID"}) ||
		!status.NoNewPrivileges || status.SeccompMode != 2 {
		t.Fatalf("kernel status changed: %#v", status)
	}
}

func TestParseCPUAndCgroupValuesRejectUnboundedOrChangedValues(t *testing.T) {
	quota, period, err := parseCPUControl("200000 100000\n")
	if err != nil || quota != 200000 || period != 100000 {
		t.Fatalf("CPU control changed: %d %d %v", quota, period, err)
	}
	for name, call := range map[string]func() error{
		"unbounded CPU":    func() error { _, _, err := parseCPUControl("max 100000\n"); return err },
		"unbounded memory": func() error { _, err := parseBoundedCgroupInteger("max\n", "memory.max"); return err },
		"negative integer": func() error { _, err := parseBoundedCgroupInteger("-1\n", "pids.max"); return err },
	} {
		t.Run(name, func(t *testing.T) {
			if err := call(); err == nil {
				t.Fatal("invalid cgroup value passed")
			}
		})
	}
}

func TestParseMountInfoFindsExactRootAndTmpfsControls(t *testing.T) {
	source := "41 29 0:35 / / rw,relatime - overlay overlay ro,lowerdir=/image\n" +
		"42 41 0:45 / /workspace rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=524288k,nr_inodes=8192,mode=710\n"
	mounts, err := parseMountInfo(source)
	if err != nil {
		t.Fatalf("parse mount information: %v", err)
	}
	if mounts["/"].Filesystem != "overlay" || !mounts["/"].SuperOptions["ro"] {
		t.Fatalf("root mount changed: %#v", mounts["/"])
	}
	workspace := mounts["/workspace"]
	if workspace.Filesystem != "tmpfs" || !workspace.Options["nosuid"] ||
		!workspace.Options["nodev"] || !workspace.Options["noexec"] {
		t.Fatalf("workspace mount changed: %#v", workspace)
	}
}

func TestParseDockerSystemFilesAcceptsThePinnedGeneratedForms(t *testing.T) {
	hostname, err := parseDockerHostname([]byte("flow-prime\n"))
	if err != nil || hostname != "flow-prime" {
		t.Fatalf("parse Docker hostname: %q %v", hostname, err)
	}
	hosts, err := parseDockerHosts([]byte(
		"127.0.0.1\tlocalhost\n" +
			"::1\tlocalhost ip6-localhost ip6-loopback\n" +
			"fe00::\tip6-localnet\n" +
			"ff00::\tip6-mcastprefix\n" +
			"ff02::1\tip6-allnodes\n" +
			"ff02::2\tip6-allrouters\n",
	))
	if err != nil || !reflect.DeepEqual(hosts, []string{
		"127.0.0.1 localhost",
		"::1 localhost ip6-localhost ip6-loopback",
		"fe00:: ip6-localnet",
		"ff00:: ip6-mcastprefix",
		"ff02::1 ip6-allnodes",
		"ff02::2 ip6-allrouters",
	}) {
		t.Fatalf("parse Docker hosts: %#v %v", hosts, err)
	}
	for _, origin := range []string{"/etc/resolv.conf", "/run/systemd/resolve/resolv.conf"} {
		resolver, err := parseDockerResolver([]byte(fixedDockerResolverDocument(origin)))
		if err != nil || !reflect.DeepEqual(resolver, []string{"nameserver 127.0.0.1", "options ndots:0"}) {
			t.Fatalf("parse Docker resolver from %s: %#v %v", origin, resolver, err)
		}
	}
}

func TestDockerSystemFileMetadataRequiresOneProtectedRootOwnedRegularFile(t *testing.T) {
	if err := validateDockerSystemFileInformation(os.FileMode(0644), 4096, 0, 0); err != nil {
		t.Fatalf("valid Docker system file metadata failed: %v", err)
	}
	tests := []struct {
		name string
		mode os.FileMode
		size int64
		uid  uint32
		gid  uint32
	}{
		{name: "symbolic link", mode: os.ModeSymlink | 0644, size: 1, uid: 0, gid: 0},
		{name: "device", mode: os.ModeDevice | 0600, size: 1, uid: 0, gid: 0},
		{name: "group writable", mode: 0664, size: 1, uid: 0, gid: 0},
		{name: "world writable", mode: 0646, size: 1, uid: 0, gid: 0},
		{name: "oversized", mode: 0644, size: 4097, uid: 0, gid: 0},
		{name: "negative size", mode: 0644, size: -1, uid: 0, gid: 0},
		{name: "non-root owner", mode: 0644, size: 1, uid: 1000, gid: 0},
		{name: "non-root group", mode: 0644, size: 1, uid: 0, gid: 1000},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateDockerSystemFileInformation(test.mode, test.size, test.uid, test.gid); err == nil {
				t.Fatal("invalid Docker system file metadata passed")
			}
		})
	}
}

func TestReadDockerSystemFileBindsOpenMetadataReadAndByteLimits(t *testing.T) {
	private := errors.New("private file fault")
	tests := []struct {
		name    string
		open    func(string) (dockerSystemFile, error)
		message string
	}{
		{name: "open", open: func(string) (dockerSystemFile, error) { return nil, private }, message: "open Docker system file"},
		{name: "inspect", open: func(string) (dockerSystemFile, error) {
			return &fakeDockerSystemFile{informationError: private}, nil
		}, message: "inspect Docker system file"},
		{name: "metadata", open: func(string) (dockerSystemFile, error) {
			return &fakeDockerSystemFile{mode: 0666, size: 1, uid: 0, gid: 0}, nil
		}, message: "inspect Docker system file"},
		{name: "read", open: func(string) (dockerSystemFile, error) {
			return &fakeDockerSystemFile{mode: 0644, size: 1, uid: 0, gid: 0, readError: private}, nil
		}, message: "read Docker system file"},
		{name: "overflow", open: func(string) (dockerSystemFile, error) {
			return &fakeDockerSystemFile{source: make([]byte, 4097), mode: 0644, size: 4096, uid: 0, gid: 0}, nil
		}, message: "read Docker system file"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			content, err := readDockerSystemFileWith("/private", test.open)
			if content != nil || err == nil || !strings.HasPrefix(err.Error(), test.message) {
				t.Fatalf("unexpected Docker system file result: %d %v", len(content), err)
			}
		})
	}
	exact, err := readDockerSystemFileWith("/private", func(string) (dockerSystemFile, error) {
		return &fakeDockerSystemFile{source: make([]byte, 4096), mode: 0644, size: 4096, uid: 0, gid: 0}, nil
	})
	if err != nil || len(exact) != 4096 {
		t.Fatalf("exact Docker system file boundary failed: %d %v", len(exact), err)
	}
}

func TestMeasureSystemFilesWithBindsMountsReadsAndNormalizedEvidence(t *testing.T) {
	private := errors.New("private measurement fault")
	mountSource := []byte(
		"41 29 0:35 / / rw,relatime - overlay overlay ro,lowerdir=/image\n" +
			"42 41 8:1 /docker/hostname /etc/hostname ro,relatime - ext4 /dev/root rw\n" +
			"43 41 8:1 /docker/hosts /etc/hosts ro,relatime - ext4 /dev/root rw\n" +
			"44 41 8:1 /docker/resolv.conf /etc/resolv.conf ro,relatime - ext4 /dev/root rw\n",
	)
	contents := map[string][]byte{
		"/etc/hostname":    []byte(fixedDockerHostname),
		"/etc/hosts":       []byte(fixedDockerHostsSource),
		"/etc/resolv.conf": []byte(fixedDockerResolverDocument("/etc/resolv.conf")),
	}
	events := make([]string, 0, 4)
	measurement, err := measureSystemFilesWith(
		func() ([]byte, error) { events = append(events, "mounts"); return mountSource, nil },
		func(path string) ([]byte, error) { events = append(events, path); return contents[path], nil },
	)
	if err != nil || !reflect.DeepEqual(events, []string{"mounts", "/etc/hostname", "/etc/hosts", "/etc/resolv.conf"}) ||
		measurement.Hostname != "flow-prime" || !reflect.DeepEqual(measurement.Hosts, fixedDockerHosts) ||
		!reflect.DeepEqual(measurement.Resolver, fixedDockerResolver) {
		t.Fatalf("system-file composition changed: %#v %#v %v", measurement, events, err)
	}

	reads := 0
	_, err = measureSystemFilesWith(
		func() ([]byte, error) { return []byte("41 29 0:35 / / rw,relatime - overlay overlay ro\n"), nil },
		func(string) ([]byte, error) { reads++; return nil, private },
	)
	if err == nil || reads != 0 {
		t.Fatalf("system files read before mount authority: %d %v", reads, err)
	}

	for _, path := range []string{"/etc/hostname", "/etc/hosts", "/etc/resolv.conf"} {
		t.Run(path, func(t *testing.T) {
			events = events[:0]
			_, err := measureSystemFilesWith(
				func() ([]byte, error) { return mountSource, nil },
				func(current string) ([]byte, error) {
					events = append(events, current)
					if current == path {
						return nil, private
					}
					return contents[current], nil
				},
			)
			if err == nil || events[len(events)-1] != path {
				t.Fatalf("system-file failure did not stop at %s: %#v %v", path, events, err)
			}
		})
	}
}

func TestParseDockerSystemFilesRejectsChangedEvidence(t *testing.T) {
	tests := []struct {
		name string
		call func() error
	}{
		{name: "hostname byte", call: func() error { _, err := parseDockerHostname([]byte("private-host\n")); return err }},
		{name: "hostname trailing bytes", call: func() error { _, err := parseDockerHostname([]byte("flow-prime\n\n")); return err }},
		{name: "hosts missing record", call: func() error { _, err := parseDockerHosts([]byte("127.0.0.1\tlocalhost\n")); return err }},
		{name: "hosts reordered", call: func() error {
			_, err := parseDockerHosts([]byte("::1\tlocalhost ip6-localhost ip6-loopback\n127.0.0.1\tlocalhost\nfe00::\tip6-localnet\nff00::\tip6-mcastprefix\nff02::1\tip6-allnodes\nff02::2\tip6-allrouters\n"))
			return err
		}},
		{name: "hosts extra record", call: func() error {
			_, err := parseDockerHosts([]byte("127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\nfe00::\tip6-localnet\nff00::\tip6-mcastprefix\nff02::1\tip6-allnodes\nff02::2\tip6-allrouters\n192.0.2.1\tprivate\n"))
			return err
		}},
		{name: "resolver changed nameserver", call: func() error {
			_, err := parseDockerResolver([]byte(strings.Replace(fixedDockerResolverDocument("/etc/resolv.conf"), "127.0.0.1", "192.0.2.1", 1)))
			return err
		}},
		{name: "resolver duplicate nameserver", call: func() error {
			_, err := parseDockerResolver([]byte(strings.Replace(fixedDockerResolverDocument("/etc/resolv.conf"), "nameserver 127.0.0.1\n", "nameserver 127.0.0.1\nnameserver 127.0.0.1\n", 1)))
			return err
		}},
		{name: "resolver missing option", call: func() error {
			_, err := parseDockerResolver([]byte(strings.Replace(fixedDockerResolverDocument("/etc/resolv.conf"), "options ndots:0\n", "", 1)))
			return err
		}},
		{name: "resolver extra option", call: func() error {
			_, err := parseDockerResolver([]byte(strings.Replace(fixedDockerResolverDocument("/etc/resolv.conf"), "options ndots:0", "options ndots:0 timeout:1", 1)))
			return err
		}},
		{name: "resolver search", call: func() error {
			_, err := parseDockerResolver([]byte(strings.Replace(fixedDockerResolverDocument("/etc/resolv.conf"), "options ndots:0\n", "search .\noptions ndots:0\n", 1)))
			return err
		}},
		{name: "resolver unknown directive", call: func() error {
			_, err := parseDockerResolver([]byte(strings.Replace(fixedDockerResolverDocument("/etc/resolv.conf"), "options ndots:0\n", "private value\noptions ndots:0\n", 1)))
			return err
		}},
		{name: "resolver unknown comment", call: func() error {
			_, err := parseDockerResolver([]byte("# PRIVATE_COMMENT\nnameserver 127.0.0.1\noptions ndots:0\n"))
			return err
		}},
		{name: "resolver oversized", call: func() error {
			_, err := parseDockerResolver([]byte("# Generated by Docker Engine.\n# " + strings.Repeat("a", 4096) + "\nnameserver 127.0.0.1\noptions ndots:0\n"))
			return err
		}},
		{name: "resolver invalid UTF-8", call: func() error { _, err := parseDockerResolver([]byte{0xff}); return err }},
		{name: "resolver embedded footer", call: func() error {
			_, err := parseDockerResolver([]byte(strings.Replace(fixedDockerResolverDocument("/etc/resolv.conf"), " (legacy)", " (internal resolver)", 1)))
			return err
		}},
		{name: "resolver external servers", call: func() error {
			_, err := parseDockerResolver([]byte(strings.Replace(fixedDockerResolverDocument("/etc/resolv.conf"), "# Overrides:", "# ExtServers: [192.0.2.1]\n# Overrides:", 1)))
			return err
		}},
		{name: "resolver missing footer", call: func() error {
			_, err := parseDockerResolver([]byte("# Generated by Docker Engine.\n# This file can be edited; Docker Engine will not make further changes once it\n# has been modified.\n\nnameserver 127.0.0.1\noptions ndots:0\n"))
			return err
		}},
		{name: "resolver directive spacing", call: func() error {
			_, err := parseDockerResolver([]byte(strings.Replace(fixedDockerResolverDocument("/etc/resolv.conf"), "nameserver 127.0.0.1", "nameserver  127.0.0.1", 1)))
			return err
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.call(); err == nil || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "192.0.2.1") {
				t.Fatalf("changed Docker system file passed or escaped private evidence: %v", err)
			}
		})
	}
}

func fixedDockerResolverDocument(origin string) string {
	return "# Generated by Docker Engine.\n" +
		"# This file can be edited; Docker Engine will not make further changes once it\n" +
		"# has been modified.\n\n" +
		"nameserver 127.0.0.1\n" +
		"options ndots:0\n\n" +
		"# Based on host file: '" + origin + "' (legacy)\n" +
		"# Overrides: [nameservers search options]\n" +
		"# Option ndots from: override\n"
}

func TestDockerSystemFileMountsRequireThreeReadOnlyMounts(t *testing.T) {
	mounts, err := parseMountInfo(
		"41 29 0:35 / / rw,relatime - overlay overlay ro,lowerdir=/image\n" +
			"42 41 8:1 /docker/hostname /etc/hostname ro,relatime - ext4 /dev/root rw\n" +
			"43 41 8:1 /docker/hosts /etc/hosts ro,relatime - ext4 /dev/root rw\n" +
			"44 41 8:1 /docker/resolv.conf /etc/resolv.conf ro,relatime - ext4 /dev/root rw\n",
	)
	if err != nil {
		t.Fatalf("parse mount information: %v", err)
	}
	if err := verifyDockerSystemFileMounts(mounts); err != nil {
		t.Fatalf("verify Docker system file mounts: %v", err)
	}
	for _, path := range []string{"/etc/hostname", "/etc/hosts", "/etc/resolv.conf"} {
		changed := make(map[string]mountInformation, len(mounts))
		for key, value := range mounts {
			changed[key] = value
		}
		changed[path] = mountInformation{Filesystem: "ext4", Options: map[string]bool{"rw": true}}
		if err := verifyDockerSystemFileMounts(changed); err == nil || strings.Contains(err.Error(), path) {
			t.Fatalf("writable or disclosed Docker system file mount %s: %v", path, err)
		}
		delete(changed, path)
		if err := verifyDockerSystemFileMounts(changed); err == nil || strings.Contains(err.Error(), path) {
			t.Fatalf("missing or disclosed Docker system file mount %s: %v", path, err)
		}
	}
}
