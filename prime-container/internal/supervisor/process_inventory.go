package supervisor

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	maxProcessInventory   = 128
	maxProcessStatusBytes = 65536
)

func listProcessesByUID(procRoot string, expectedUID int) ([]int, error) {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil, fmt.Errorf("read Prime process inventory: %w", err)
	}
	processes := make([]int, 0)
	numericEntries := 0
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid < 1 {
			continue
		}
		numericEntries++
		if numericEntries > maxProcessInventory {
			return nil, errors.New("Prime process inventory exceeds its count limit")
		}
		matches, err := processHasExactUID(filepath.Join(procRoot, entry.Name(), "status"), expectedUID)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		if matches {
			processes = append(processes, pid)
		}
	}
	sort.Ints(processes)
	return processes, nil
}

func processHasExactUID(statusPath string, expectedUID int) (bool, error) {
	file, err := os.Open(statusPath)
	if err != nil {
		return false, err
	}
	defer file.Close()
	reader := bufio.NewReader(io.LimitReader(file, maxProcessStatusBytes+1))
	found := false
	for {
		line, readError := reader.ReadString('\n')
		if len(line) > 0 {
			if strings.HasPrefix(line, "Uid:") {
				if found {
					return false, errors.New("Linux process status repeats its user identity")
				}
				found = true
				fields := strings.Fields(strings.TrimPrefix(line, "Uid:"))
				if len(fields) != 4 {
					return false, errors.New("Linux process user identity is invalid")
				}
				for _, field := range fields {
					uid, err := strconv.Atoi(field)
					if err != nil || uid != expectedUID {
						return false, nil
					}
				}
			}
		}
		if errors.Is(readError, io.EOF) {
			break
		}
		if readError != nil {
			return false, fmt.Errorf("read Linux process status: %w", readError)
		}
	}
	if !found {
		return false, errors.New("Linux process status omits its user identity")
	}
	return true, nil
}
