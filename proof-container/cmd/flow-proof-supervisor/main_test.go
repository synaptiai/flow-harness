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
