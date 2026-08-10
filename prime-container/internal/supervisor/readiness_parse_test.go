package supervisor

import (
	"reflect"
	"testing"
)

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
