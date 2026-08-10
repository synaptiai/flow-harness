package supervisor

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

func TestListProcessesByUIDUsesAllFourLinuxIdentityFields(t *testing.T) {
	root := t.TempDir()
	for name, status := range map[string]string{
		"101":       "Name:\tpython\nUid:\t10002\t10002\t10002\t10002\n",
		"102":       "Name:\tchanged\nUid:\t10002\t10002\t0\t10002\n",
		"103":       "Name:\tnode\nUid:\t10001\t10001\t10001\t10001\n",
		"not-a-pid": "Name:\tignored\nUid:\t10002\t10002\t10002\t10002\n",
	} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatalf("create process fixture: %v", err)
		}
		if err := os.WriteFile(filepath.Join(root, name, "status"), []byte(status), 0600); err != nil {
			t.Fatalf("write process fixture: %v", err)
		}
	}

	processes, err := listProcessesByUID(root, PythonUID)
	if err != nil {
		t.Fatalf("list Python processes: %v", err)
	}
	if !reflect.DeepEqual(processes, []int{101}) {
		t.Fatalf("process inventory changed: %#v", processes)
	}
}

func TestListProcessesByUIDRejectsAnOversizedInventory(t *testing.T) {
	root := t.TempDir()
	for process := 1; process <= maxProcessInventory+1; process++ {
		path := filepath.Join(root, strconv.Itoa(1000+process))
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatalf("create process fixture: %v", err)
		}
	}
	if _, err := listProcessesByUID(root, PythonUID); err == nil {
		t.Fatal("oversized process inventory passed")
	}
}
