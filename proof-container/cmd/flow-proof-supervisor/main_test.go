package main

import (
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func TestReadRequestRequiresExactContentIdentities(t *testing.T) {
	statement := "theorem Flow.Proof.add_zero (n : Nat) : n + 0 = n"
	proof := "by\n  omega\n"
	input := `{"version":1,"requestDigest":"` + strings.Repeat("a", 64) +
		`","statement":` + quote(statement) + `,"statementDigest":"` + digest([]byte(statement)) +
		`","proof":` + quote(proof) + `,"proofDigest":"` + digest([]byte(proof)) +
		`","targetDeclaration":"Flow.Proof.add_zero"}`
	request, err := readRequest(strings.NewReader(input))
	if err != nil {
		t.Fatalf("read request: %v", err)
	}
	if request.TargetDeclaration != "Flow.Proof.add_zero" {
		t.Fatalf("unexpected declaration %q", request.TargetDeclaration)
	}

	changed := strings.Replace(input, digest([]byte(proof)), strings.Repeat("b", 64), 1)
	if _, err := readRequest(strings.NewReader(changed)); err == nil {
		t.Fatal("expected changed proof identity to fail")
	}
}

func TestReadRequestAcceptsDeclarationDelimiterAndTrailingApostrophe(t *testing.T) {
	statement := "theorem Flow.Proof.identity'\n  (value : Nat) : value = value"
	proof := "by\n  rfl\n"
	input := `{"version":1,"requestDigest":"` + strings.Repeat("a", 64) +
		`","statement":` + quote(statement) + `,"statementDigest":"` + digest([]byte(statement)) +
		`","proof":` + quote(proof) + `,"proofDigest":"` + digest([]byte(proof)) +
		`","targetDeclaration":"Flow.Proof.identity'"}`

	if _, err := readRequest(strings.NewReader(input)); err != nil {
		t.Fatalf("read request with valid declaration delimiter: %v", err)
	}
}

func TestSourcePolicyRejectsIncompleteAndExecutableMetaprogramConstructs(t *testing.T) {
	base := request{Statement: "theorem Flow.Proof.safe : True", Proof: "by trivial"}
	for _, proof := range []string{"by sorry", "by admit", "by run_tac IO.println \"x\"", "by exact Lean.trustCompiler"} {
		base.Proof = proof
		if validateSourcePolicy(base) == "" {
			t.Fatalf("expected policy rejection for %q", proof)
		}
	}
	base.Proof = "by\n  trivial"
	if reason := validateSourcePolicy(base); reason != "" {
		t.Fatalf("unexpected safe proof rejection: %s", reason)
	}
}

func TestRuntimeToolsUsePinnedBinariesAndExplicitLeanPath(t *testing.T) {
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
	}

	target := leanCommandSpec(paths.targetSource, paths.targetOlean, paths.targetHome, proofUID, proofGID)
	assertCommandSpec(t, target, "/opt/lean/bin/lean", "/workspace/target",
		[]string{paths.targetSource, "-o", paths.targetOlean},
		[]string{
			"LEAN_PATH=/opt/flow/lean-lib",
			"LD_LIBRARY_PATH=/opt/lean/lib/lean:/opt/flow/shared-lib",
		})

	safeVerify := safeVerifyCommandSpec(paths)
	assertCommandSpec(t, safeVerify, "/opt/flow/bin/safe_verify", "/workspace/frozen",
		[]string{paths.frozenTarget, paths.frozenSubmission},
		[]string{
			"LEAN_PATH=/workspace/frozen/.lake/build/lib/lean:/opt/flow/lean-lib",
			"LD_LIBRARY_PATH=/opt/lean/lib/lean:/opt/flow/shared-lib",
		})

	export := lean4ExportCommandSpec(paths, []string{"Flow.Proof.safe"})
	assertCommandSpec(t, export, "/opt/flow/bin/lean4export", "/workspace/frozen",
		[]string{"Submission", "--", "Flow.Proof.safe"},
		[]string{
			"LEAN_PATH=/workspace/frozen/.lake/build/lib/lean:/opt/flow/lean-lib",
			"LD_LIBRARY_PATH=/opt/lean/lib/lean:/opt/flow/shared-lib",
		})
}

func TestCompilerRejectionReasonUsesOnlyStableDiagnosticCategories(t *testing.T) {
	tests := []struct {
		diagnostic string
		expected   string
	}{
		{"error: unknown module prefix 'Mathlib'", "target_compiler_module_unavailable"},
		{"permission denied: /opt/flow/mathlib/.lake/build/lib/lean/Mathlib.olean", "target_compiler_dependency_tree_denied"},
		{"permission denied: /opt/lean/lib/lean/Init.olean", "target_compiler_toolchain_denied"},
		{"permission denied: /workspace/target/Challenge.lean", "target_compiler_workspace_source_denied"},
		{"permission denied: /workspace/target/.lake/build/lib/lean/Challenge.olean", "target_compiler_workspace_output_denied"},
		{"error: permission denied: /private/source", "target_compiler_filesystem_denied"},
		{"error while loading shared libraries: libLean.so", "target_compiler_shared_library_unavailable"},
		{"failed to create thread: resource temporarily unavailable", "target_compiler_resource_unavailable"},
		{"proof term has type False but is expected to have type True", "target_compilation_rejected"},
	}
	for _, test := range tests {
		reason := compilerRejectionReason("target", commandResult{
			ExitCode: 1, Diagnostic: []byte(test.diagnostic),
		})
		if reason != test.expected {
			t.Fatalf("unexpected reason for %q: %s", test.diagnostic, reason)
		}
		if strings.Contains(reason, "private") || strings.Contains(reason, "Mathlib") {
			t.Fatalf("reason disclosed diagnostic content: %s", reason)
		}
	}
}

func TestParseObservedAxiomsUsesLastTargetReplay(t *testing.T) {
	output := strings.Join([]string{
		"Flow.Proof.safe", "True", "#[sorryAx]", "---", "theorem",
		"Flow.Proof.safe", "True", "#[Classical.choice, propext, Quot.sound]", "",
	}, "\n")
	observed, found := parseObservedAxioms([]byte(output), "Flow.Proof.safe")
	if !found {
		t.Fatal("expected target axiom evidence")
	}
	expected := []string{"Classical.choice", "Quot.sound", "propext"}
	if strings.Join(observed, ",") != strings.Join(expected, ",") {
		t.Fatalf("unexpected axioms: %#v", observed)
	}
}

func TestSafeVerifyFailureWithoutTargetEvidenceIsUnavailable(t *testing.T) {
	req := request{TargetDeclaration: "Flow.Proof.safe", StatementDigest: strings.Repeat("a", 64)}
	evidence := safeVerifyEvidence(req, strings.Repeat("b", 64), commandResult{
		ExitCode: 1, Diagnostic: []byte("replay failed before target evidence"), DurationMS: 7,
	})
	if evidence["status"] != "unavailable" || evidence["reasonCode"] != "kernel_replay_failed_before_evidence" {
		t.Fatalf("unexpected incomplete replay evidence: %#v", evidence)
	}
	if _, present := evidence["observedAxioms"]; present {
		t.Fatalf("incomplete replay evidence must not synthesize observed axioms: %#v", evidence)
	}
}

func TestSafeVerifyUnavailableReasonUsesOnlyStableDiagnosticCategories(t *testing.T) {
	tests := []struct {
		diagnostic string
		expected   string
	}{
		{"could not find lakefile for '/private/input.olean'", "kernel_replay_artifact_layout_invalid"},
		{"object file '/private/Mathlib.olean' does not exist", "kernel_replay_module_unavailable"},
		{"error while loading shared libraries: libLean.so", "kernel_replay_shared_library_unavailable"},
		{"permission denied: /private/input.olean", "kernel_replay_filesystem_denied"},
	}
	for _, test := range tests {
		reason := safeVerifyUnavailableReason(commandResult{ExitCode: 1, Diagnostic: []byte(test.diagnostic)})
		if reason != test.expected {
			t.Fatalf("unexpected reason for %q: %s", test.diagnostic, reason)
		}
		if strings.Contains(reason, "private") || strings.Contains(reason, "Mathlib") {
			t.Fatalf("reason disclosed diagnostic content: %s", reason)
		}
	}
}

func TestRunCommandRemovesBackgroundDescendants(t *testing.T) {
	result := runCommand(commandSpec{
		path: "/bin/sh",
		args: []string{"-c", "sleep 30 >/dev/null 2>&1 & echo $!"},
	})
	if result.ExitCode != 0 {
		t.Fatalf("run command: exit %d: %s", result.ExitCode, result.Diagnostic)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(result.Diagnostic)))
	if err != nil {
		t.Fatalf("parse descendant pid: %v", err)
	}
	if err := syscall.Kill(pid, 0); err == nil {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("background descendant %d survived command settlement", pid)
	}
}

func quote(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	value = strings.ReplaceAll(value, "\n", `\n`)
	return `"` + value + `"`
}

func assertCommandSpec(
	t *testing.T,
	spec commandSpec,
	path string,
	dir string,
	args []string,
	env []string,
) {
	t.Helper()
	if spec.path != path || spec.dir != dir || strings.Join(spec.args, "\x00") != strings.Join(args, "\x00") ||
		strings.Join(spec.env, "\x00") != strings.Join(env, "\x00") {
		t.Fatalf("unexpected command spec: %#v", spec)
	}
}
