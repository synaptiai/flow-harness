package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	maxRequestBytes    = 524288
	maxDiagnosticBytes = 1048576
	maxArtifactBytes   = 268435456
	proofUID           = 10001
	proofGID           = 10001
)

var (
	sha256Pattern          = regexp.MustCompile(`^[a-f0-9]{64}$`)
	declarationPattern     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)+$`)
	statementHeaderPattern = regexp.MustCompile(`(?s)^\s*(theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)+)`)
	reservedSource         = regexp.MustCompile(`(?i)(^|[^A-Za-z0-9_'])(sorry|admit|axiom|unsafe|partial|run_tac|initialize|#eval|Lean\.trustCompiler)([^A-Za-z0-9_']|$)`)
	allowedAxioms          = []string{"propext", "Quot.sound", "Classical.choice"}
	exportTargets          = []string{
		"Nat", "String", "String.mk", "Char", "Char.ofNat", "List",
		"Quot", "Quot.mk", "Quot.lift", "Quot.ind",
		"Nat.add", "Nat.sub", "Nat.mul", "Nat.pow", "Nat.gcd", "Nat.div", "Nat.mod",
		"Nat.beq", "Nat.ble", "Nat.land", "Nat.lor", "Nat.xor", "Nat.shiftLeft",
		"Nat.shiftRight", "String.ofList",
	}
)

type request struct {
	Version           int    `json:"version"`
	RequestDigest     string `json:"requestDigest"`
	Statement         string `json:"statement"`
	StatementDigest   string `json:"statementDigest"`
	Proof             string `json:"proof"`
	ProofDigest       string `json:"proofDigest"`
	TargetDeclaration string `json:"targetDeclaration"`
}

type result struct {
	Version       int            `json:"version"`
	RequestDigest string         `json:"requestDigest"`
	Compiler      map[string]any `json:"compiler"`
	SafeVerify    map[string]any `json:"safeVerify"`
	Nanoda        map[string]any `json:"nanoda"`
}

type commandResult struct {
	ExitCode   int
	Diagnostic []byte
	DurationMS int64
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--probe" {
		probe()
		return
	}
	if err := supervise(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "Lean proof supervisor failed closed")
		os.Exit(1)
	}
}

func supervise() error {
	if err := verifyRuntimeContainment(); err != nil {
		return err
	}
	req, err := readRequest(os.Stdin)
	if err != nil {
		return err
	}
	settlement := executeProof(req)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(true)
	return encoder.Encode(settlement)
}

func executeProof(req request) result {
	base := result{Version: 1, RequestDigest: req.RequestDigest}
	started := time.Now()
	if reason := validateSourcePolicy(req); reason != "" {
		base.Compiler = rejected("source_policy_rejected", elapsedMS(started))
		base.SafeVerify = notRun("compiler_rejected")
		base.Nanoda = notRun("compiler_rejected")
		return base
	}

	paths, err := prepareTargetWorkspace(req)
	if err != nil {
		base.Compiler = unavailable("workspace_unavailable", elapsedMS(started))
		base.SafeVerify = notRun("compiler_unavailable")
		base.Nanoda = notRun("compiler_unavailable")
		return base
	}

	targetCompile := runLean(paths.targetSource, paths.targetOlean, paths.targetHome, proofUID, proofGID)
	if targetCompile.ExitCode != 0 {
		base.Compiler = rejected(compilerRejectionReason("target", targetCompile), targetCompile.DurationMS)
		base.SafeVerify = notRun("compiler_rejected")
		base.Nanoda = notRun("compiler_rejected")
		return base
	}
	if err := lockCompilerTree(paths.targetRoot); err != nil {
		base.Compiler = unavailable("compiled_artifact_unavailable", elapsedMS(started))
		base.SafeVerify = notRun("compiler_unavailable")
		base.Nanoda = notRun("compiler_unavailable")
		return base
	}
	if err := freezeTargetArtifact(paths); err != nil {
		base.Compiler = unavailable("compiled_artifact_unavailable", elapsedMS(started))
		base.SafeVerify = notRun("compiler_unavailable")
		base.Nanoda = notRun("compiler_unavailable")
		return base
	}
	if err := prepareSubmissionWorkspace(req, paths); err != nil {
		base.Compiler = unavailable("workspace_unavailable", elapsedMS(started))
		base.SafeVerify = notRun("compiler_unavailable")
		base.Nanoda = notRun("compiler_unavailable")
		return base
	}
	submissionCompile := runLean(
		paths.submissionSource, paths.submissionOlean, paths.submissionHome, proofUID, proofGID,
	)
	if submissionCompile.ExitCode != 0 {
		base.Compiler = rejected(
			compilerRejectionReason("submission", submissionCompile), submissionCompile.DurationMS,
		)
		base.SafeVerify = notRun("compiler_rejected")
		base.Nanoda = notRun("compiler_rejected")
		return base
	}
	if err := lockCompilerTree(paths.submissionRoot); err != nil {
		base.Compiler = unavailable("compiled_artifact_unavailable", elapsedMS(started))
		base.SafeVerify = notRun("compiler_unavailable")
		base.Nanoda = notRun("compiler_unavailable")
		return base
	}

	environmentDigest, err := freezeSubmissionArtifacts(paths)
	if err != nil {
		base.Compiler = unavailable("compiled_artifact_unavailable", elapsedMS(started))
		base.SafeVerify = notRun("compiler_unavailable")
		base.Nanoda = notRun("compiler_unavailable")
		return base
	}
	base.Compiler = map[string]any{
		"status": "accepted", "targetDeclaration": req.TargetDeclaration,
		"statementDigest": req.StatementDigest, "environmentDigest": environmentDigest,
		"durationMs": targetCompile.DurationMS + submissionCompile.DurationMS,
	}

	safe := runSafeVerify(req, paths, environmentDigest)
	base.SafeVerify = safe
	base.Nanoda = runNanoda(req, paths, environmentDigest)
	return base
}

func compilerRejectionReason(phase string, command commandResult) string {
	diagnostic := strings.ToLower(string(command.Diagnostic))
	switch {
	case strings.Contains(diagnostic, "unknown module") ||
		strings.Contains(diagnostic, "unknown package") ||
		strings.Contains(diagnostic, "object file") && strings.Contains(diagnostic, "does not exist"):
		return phase + "_compiler_module_unavailable"
	case strings.Contains(diagnostic, "error while loading shared libraries") ||
		strings.Contains(diagnostic, "cannot open shared object file") ||
		strings.Contains(diagnostic, "error loading library"):
		return phase + "_compiler_shared_library_unavailable"
	case strings.Contains(diagnostic, "permission denied") ||
		strings.Contains(diagnostic, "operation not permitted"):
		return phase + "_compiler_filesystem_denied"
	case strings.Contains(diagnostic, "failed to create thread") ||
		strings.Contains(diagnostic, "resource temporarily unavailable") ||
		strings.Contains(diagnostic, "cannot allocate memory"):
		return phase + "_compiler_resource_unavailable"
	case len(command.Diagnostic) == 0:
		return phase + "_compiler_execution_unavailable"
	default:
		return phase + "_compilation_rejected"
	}
}

type workspacePaths struct {
	targetRoot       string
	targetHome       string
	targetSource     string
	targetOlean      string
	submissionRoot   string
	submissionHome   string
	submissionSource string
	submissionOlean  string
	frozenTarget     string
	frozenSubmission string
	exportFile       string
	nanodaConfig     string
}

func prepareTargetWorkspace(req request) (workspacePaths, error) {
	paths := workspacePaths{
		targetRoot:       "/workspace/target",
		targetHome:       "/workspace/target/home",
		targetSource:     "/workspace/target/Challenge.lean",
		targetOlean:      "/workspace/target/.lake/build/lib/lean/Challenge.olean",
		submissionRoot:   "/workspace/submission",
		submissionHome:   "/workspace/submission/home",
		submissionSource: "/workspace/submission/Submission.lean",
		submissionOlean:  "/workspace/submission/.lake/build/lib/lean/Submission.olean",
		frozenTarget:     "/workspace/frozen/.lake/build/lib/lean/Challenge.olean",
		frozenSubmission: "/workspace/frozen/.lake/build/lib/lean/Submission.olean",
		exportFile:       "/workspace/frozen/submission.export",
		nanodaConfig:     "/workspace/frozen/nanoda.json",
	}
	for _, path := range []string{
		filepath.Dir(paths.targetOlean), filepath.Dir(paths.frozenTarget),
		paths.targetHome, "/workspace/home",
	} {
		if err := os.MkdirAll(path, 0700); err != nil {
			return workspacePaths{}, err
		}
	}
	for _, path := range []string{
		paths.targetRoot, "/workspace/target/.lake",
		"/workspace/target/.lake/build", "/workspace/target/.lake/build/lib",
		filepath.Dir(paths.targetOlean), paths.targetHome,
	} {
		if err := os.Chmod(path, 0770); err != nil {
			return workspacePaths{}, err
		}
	}
	target := "import Mathlib\n\n" + req.Statement + " := by\n  sorry\n"
	if err := os.WriteFile(paths.targetSource, []byte(target), 0640); err != nil {
		return workspacePaths{}, err
	}
	return paths, nil
}

func prepareSubmissionWorkspace(req request, paths workspacePaths) error {
	for _, path := range []string{filepath.Dir(paths.submissionOlean), paths.submissionHome} {
		if err := os.MkdirAll(path, 0700); err != nil {
			return err
		}
	}
	for _, path := range []string{
		paths.submissionRoot, "/workspace/submission/.lake",
		"/workspace/submission/.lake/build", "/workspace/submission/.lake/build/lib",
		filepath.Dir(paths.submissionOlean), paths.submissionHome,
	} {
		if err := os.Chmod(path, 0770); err != nil {
			return err
		}
	}
	submission := "import Mathlib\n\n" + req.Statement + " := " + req.Proof + "\n"
	return os.WriteFile(paths.submissionSource, []byte(submission), 0640)
}

func lockCompilerTree(root string) error {
	return os.Chmod(root, 0700)
}

func runLean(source string, olean string, home string, uid uint32, gid uint32) commandResult {
	return runCommand(leanCommandSpec(source, olean, home, uid, gid))
}

func leanCommandSpec(source string, olean string, home string, uid uint32, gid uint32) commandSpec {
	return commandSpec{
		path: "/opt/lean/bin/lean",
		args: []string{source, "-o", olean},
		dir:  filepath.Dir(source),
		env:  runtimeLeanEnvironment(),
		home: home,
		uid:  uid,
		gid:  gid,
	}
}

func freezeTargetArtifact(paths workspacePaths) error {
	target, err := readRegularNoFollow(paths.targetOlean, maxArtifactBytes)
	if err != nil {
		return err
	}
	return os.WriteFile(paths.frozenTarget, target, 0600)
}

func freezeSubmissionArtifacts(paths workspacePaths) (string, error) {
	submission, err := readRegularNoFollow(paths.submissionOlean, maxArtifactBytes)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(paths.frozenSubmission, submission, 0600); err != nil {
		return "", err
	}
	if err := linkLibraryEntries(filepath.Dir(paths.frozenTarget)); err != nil {
		return "", err
	}
	return digest(submission), nil
}

func linkLibraryEntries(targetDirectory string) error {
	entries, err := os.ReadDir("/opt/flow/lean-lib")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "Challenge.olean" || entry.Name() == "Submission.olean" {
			return errors.New("fixed Lean library collides with a proof module")
		}
		target := filepath.Join("/opt/flow/lean-lib", entry.Name())
		link := filepath.Join(targetDirectory, entry.Name())
		if err := os.Symlink(target, link); err != nil {
			return err
		}
	}
	return nil
}

func runSafeVerify(req request, paths workspacePaths, environmentDigest string) map[string]any {
	command := runCommand(safeVerifyCommandSpec(paths))
	axioms, foundAxioms := parseObservedAxioms(command.Diagnostic, req.TargetDeclaration)
	if command.ExitCode == 0 && !foundAxioms {
		return unavailable("kernel_replay_output_unavailable", command.DurationMS)
	}
	status := "accepted"
	reason := "accepted"
	if command.ExitCode != 0 {
		status = "rejected"
		reason = "kernel_replay_rejected"
	}
	return map[string]any{
		"status": status, "targetDeclaration": req.TargetDeclaration,
		"statementDigest": req.StatementDigest, "environmentDigest": environmentDigest,
		"observedAxioms": axioms, "reasonCode": reason, "durationMs": command.DurationMS,
	}
}

func safeVerifyCommandSpec(paths workspacePaths) commandSpec {
	return commandSpec{
		path: "/opt/flow/bin/safe_verify",
		args: []string{paths.frozenTarget, paths.frozenSubmission},
		dir:  "/workspace/frozen",
		env:  runtimeLeanEnvironment(filepath.Dir(paths.frozenTarget)),
	}
}

func runNanoda(req request, paths workspacePaths, environmentDigest string) map[string]any {
	targets := append(append([]string{}, exportTargets...), req.TargetDeclaration)
	targets = append(targets, allowedAxioms...)
	exportStarted := time.Now()
	exportDiagnostic, exportExit := runCommandToFile(
		lean4ExportCommandSpec(paths, targets), paths.exportFile,
	)
	_ = exportDiagnostic
	if exportExit != 0 {
		return unavailable("export_unavailable", elapsedMS(exportStarted))
	}
	if _, err := readRegularNoFollow(paths.exportFile, maxArtifactBytes); err != nil {
		return unavailable("export_unavailable", elapsedMS(exportStarted))
	}
	config := map[string]any{
		"export_file_path":             paths.exportFile,
		"use_stdin":                    false,
		"permitted_axioms":             allowedAxioms,
		"unpermitted_axiom_hard_error": true,
		"num_threads":                  1,
		"nat_extension":                true,
		"string_extension":             true,
		"pp_declars":                   []string{},
		"unknown_pp_declar_hard_error": true,
		"pp_output_path":               nil,
		"pp_to_stdout":                 false,
		"print_success_message":        false,
		"print_axioms":                 false,
		"unsafe_permit_all_axioms":     false,
	}
	configBytes, err := json.Marshal(config)
	if err != nil || os.WriteFile(paths.nanodaConfig, configBytes, 0600) != nil {
		return unavailable("nanoda_configuration_unavailable", elapsedMS(exportStarted))
	}
	nanoda := runCommand(commandSpec{
		path: "/opt/flow/bin/nanoda_bin", args: []string{paths.nanodaConfig}, dir: "/workspace/frozen",
	})
	status := "accepted"
	reason := "accepted"
	if nanoda.ExitCode != 0 {
		status = "rejected"
		reason = "independent_kernel_rejected"
	}
	return map[string]any{
		"status": status, "environmentDigest": environmentDigest,
		"reasonCode": reason, "durationMs": elapsedMS(exportStarted),
	}
}

func lean4ExportCommandSpec(paths workspacePaths, targets []string) commandSpec {
	args := []string{"Submission", "--"}
	args = append(args, targets...)
	return commandSpec{
		path: "/opt/flow/bin/lean4export",
		args: args,
		dir:  "/workspace/frozen",
		env:  runtimeLeanEnvironment(filepath.Dir(paths.frozenSubmission)),
	}
}

func runtimeLeanEnvironment(extraLeanPath ...string) []string {
	return []string{
		"LEAN_PATH=" + strings.Join(append(extraLeanPath, "/opt/flow/lean-lib"), ":"),
		"LD_LIBRARY_PATH=/opt/lean/lib/lean:/opt/flow/shared-lib",
	}
}

type commandSpec struct {
	path string
	args []string
	dir  string
	env  []string
	home string
	uid  uint32
	gid  uint32
}

func runCommand(spec commandSpec) commandResult {
	started := time.Now()
	buffer := &boundedBuffer{limit: maxDiagnosticBytes}
	command := newCommand(spec)
	command.Stdout = buffer
	command.Stderr = buffer
	err := runAndReap(command)
	return commandResult{
		ExitCode: exitCode(err), Diagnostic: buffer.Bytes(), DurationMS: elapsedMS(started),
	}
}

func runCommandToFile(spec commandSpec, outputPath string) ([]byte, int) {
	file, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, 255
	}
	defer file.Close()
	diagnostic := &boundedBuffer{limit: maxDiagnosticBytes}
	command := newCommand(spec)
	command.Stdout = &boundedFileWriter{file: file, limit: maxArtifactBytes}
	command.Stderr = diagnostic
	err = runAndReap(command)
	if syncErr := file.Sync(); err == nil && syncErr != nil {
		err = syncErr
	}
	return diagnostic.Bytes(), exitCode(err)
}

func newCommand(spec commandSpec) *exec.Cmd {
	command := exec.CommandContext(context.Background(), spec.path, spec.args...)
	command.Dir = spec.dir
	command.Env = fixedEnvironment(spec.home, spec.env)
	command.SysProcAttr = proofProcessAttributes(spec.uid, spec.gid)
	return command
}

func runAndReap(command *exec.Cmd) error {
	if err := command.Start(); err != nil {
		return err
	}
	pid := command.Process.Pid
	commandErr := command.Wait()
	reapErr := terminateProofProcessGroup(pid)
	if commandErr != nil {
		return commandErr
	}
	return reapErr
}

func fixedEnvironment(home string, extra []string) []string {
	if home == "" {
		home = "/workspace/home"
	}
	environment := []string{
		"HOME=" + home, "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
		"PATH=/opt/flow/bin:/opt/lean/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LEAN_ABORT_ON_PANIC=1",
	}
	return append(environment, extra...)
}

func readRequest(reader io.Reader) (request, error) {
	limited := io.LimitReader(reader, maxRequestBytes+1)
	payloadBytes, err := io.ReadAll(limited)
	if err != nil {
		return request{}, err
	}
	if len(payloadBytes) > maxRequestBytes {
		return request{}, errors.New("request exceeds byte limit")
	}
	decoder := json.NewDecoder(bufio.NewReader(bytes.NewReader(payloadBytes)))
	decoder.DisallowUnknownFields()
	var req request
	if err := decoder.Decode(&req); err != nil {
		return request{}, err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return request{}, errors.New("request contains trailing JSON")
	}
	if err := validateRequest(req); err != nil {
		return request{}, err
	}
	return req, nil
}

func validateRequest(req request) error {
	if req.Version != 1 || !sha256Pattern.MatchString(req.RequestDigest) ||
		!sha256Pattern.MatchString(req.StatementDigest) || !sha256Pattern.MatchString(req.ProofDigest) ||
		!declarationPattern.MatchString(req.TargetDeclaration) ||
		digest([]byte(req.Statement)) != req.StatementDigest || digest([]byte(req.Proof)) != req.ProofDigest {
		return errors.New("request identity is invalid")
	}
	if len(req.Statement) == 0 || len(req.Statement) > 131072 || len(req.Proof) == 0 || len(req.Proof) > 262144 {
		return errors.New("request content exceeds its bounds")
	}
	header := statementHeaderPattern.FindStringSubmatch(req.Statement)
	if len(header) < 3 || header[2] != req.TargetDeclaration ||
		strings.Contains(req.Statement, ":=") || !strings.HasPrefix(strings.TrimSpace(req.Proof), "by") {
		return errors.New("statement and proof shape is invalid")
	}
	return nil
}

func validateSourcePolicy(req request) string {
	if reservedSource.MatchString(req.Statement) || reservedSource.MatchString(req.Proof) {
		return "source_policy_rejected"
	}
	return ""
}

func parseObservedAxioms(output []byte, target string) ([]string, bool) {
	lines := strings.Split(string(output), "\n")
	var observed []string
	for index, line := range lines {
		if strings.TrimSpace(line) != target {
			continue
		}
		for next := index + 1; next < len(lines); next++ {
			candidate := strings.TrimSpace(lines[next])
			if candidate == "---" {
				break
			}
			if !strings.HasPrefix(candidate, "#[") || !strings.HasSuffix(candidate, "]") {
				continue
			}
			body := strings.TrimSuffix(strings.TrimPrefix(candidate, "#["), "]")
			if strings.TrimSpace(body) == "" {
				observed = []string{}
				break
			}
			parts := strings.Split(body, ",")
			parsed := make([]string, 0, len(parts))
			for _, part := range parts {
				name := strings.TrimSpace(part)
				if name != "" {
					parsed = append(parsed, name)
				}
			}
			observed = parsed
			break
		}
	}
	sort.Strings(observed)
	return observed, observed != nil
}

type boundedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (writer *boundedBuffer) Write(value []byte) (int, error) {
	remaining := writer.limit - writer.buffer.Len()
	if remaining <= 0 {
		return 0, errors.New("diagnostic exceeds byte limit")
	}
	if len(value) > remaining {
		_, _ = writer.buffer.Write(value[:remaining])
		return remaining, errors.New("diagnostic exceeds byte limit")
	}
	return writer.buffer.Write(value)
}

func (writer *boundedBuffer) Bytes() []byte { return writer.buffer.Bytes() }

type boundedFileWriter struct {
	file  *os.File
	bytes int64
	limit int64
}

func (writer *boundedFileWriter) Write(value []byte) (int, error) {
	if writer.bytes+int64(len(value)) > writer.limit {
		return 0, errors.New("artifact exceeds byte limit")
	}
	written, err := writer.file.Write(value)
	writer.bytes += int64(written)
	return written, err
}

func readRegularNoFollow(path string, limit int64) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	metadata, err := file.Stat()
	if err != nil || !metadata.Mode().IsRegular() || metadata.Size() < 1 || metadata.Size() > limit {
		return nil, errors.New("artifact is not a bounded regular file")
	}
	return io.ReadAll(io.LimitReader(file, limit+1))
}

func rejected(reason string, duration int64) map[string]any {
	return map[string]any{"status": "rejected", "reasonCode": reason, "durationMs": duration}
}

func unavailable(reason string, duration int64) map[string]any {
	return map[string]any{"status": "unavailable", "reasonCode": reason, "durationMs": duration}
}

func notRun(reason string) map[string]any {
	return map[string]any{"status": "not_run", "reasonCode": reason, "durationMs": int64(0)}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return 255
}

func elapsedMS(started time.Time) int64 {
	value := time.Since(started).Milliseconds()
	if value < 0 {
		return 0
	}
	return value
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func probe() {
	artifacts := map[string]string{}
	for name, path := range map[string]string{
		"supervisorSha256":      "/opt/flow/bin/flow-proof-supervisor",
		"safeVerifySha256":      "/opt/flow/bin/safe_verify",
		"lean4exportSha256":     "/opt/flow/bin/lean4export",
		"nanodaSha256":          "/opt/flow/bin/nanoda_bin",
		"mathlibManifestSha256": "/opt/flow/mathlib/lake-manifest.json",
	} {
		value, err := digestFile(path)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "Lean proof image probe failed closed")
			os.Exit(1)
		}
		artifacts[name] = value
	}
	value := map[string]any{
		"version":                  1,
		"platform":                 "linux",
		"architecture":             "x64",
		"leanVersion":              buildLeanVersion,
		"mathlibRevision":          buildMathlibRevision,
		"safeVerifyRevision":       buildSafeVerifyRevision,
		"lean4exportRevision":      buildLean4ExportRevision,
		"nanodaRevision":           buildNanodaRevision,
		"profileDigest":            buildProfileDigest,
		"dependencyManifestDigest": buildDependencyManifestDigest,
		"artifacts":                artifacts,
		"allowedAxioms":            allowedAxioms,
	}
	_ = json.NewEncoder(os.Stdout).Encode(value)
}

func digestFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

var (
	buildLeanVersion              = "development"
	buildMathlibRevision          = "development"
	buildSafeVerifyRevision       = "development"
	buildLean4ExportRevision      = "development"
	buildNanodaRevision           = "development"
	buildProfileDigest            = "development"
	buildDependencyManifestDigest = "development"
)
