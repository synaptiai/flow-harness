import { describe, expect, it } from "vitest";

import {
  calculateIssueReviewReportDigest,
  type IssueReviewReportError,
  parseIssueReviewReport,
} from "../../../src/domain/issue-lifecycle/review.js";

describe("issue review report", () => {
  it("matches the version-1 compatibility vector", () => {
    const report = parseIssueReviewReport(clearReport(), ["AC-1", "AC-2"], expectation());

    expect(calculateIssueReviewReportDigest(report, ["AC-1", "AC-2"], expectation())).toBe(
      "c043b005c36bb32beb84b8e9ca7081f9ff4d7024105f7817c08878c6bf6242e2",
    );
  });

  it("rejects a digest request whose verdict hides an unsatisfied criterion", () => {
    const report = clearReport();
    report.acceptanceMapping[1] = {
      criterionId: "AC-2",
      status: "unsatisfied",
      evidence: "No candidate evidence satisfies AC-2.",
    };

    expect(() =>
      calculateIssueReviewReportDigest(report, ["AC-1", "AC-2"], expectation()),
    ).toThrowError(
      expect.objectContaining<Partial<IssueReviewReportError>>({ code: "inconsistent_verdict" }),
    );
  });

  it("rejects a digest request that blocks without a problem", () => {
    const report = clearReport();
    report.verdict = "blocked";

    expect(() =>
      calculateIssueReviewReportDigest(report, ["AC-1", "AC-2"], expectation()),
    ).toThrowError(
      expect.objectContaining<Partial<IssueReviewReportError>>({ code: "inconsistent_verdict" }),
    );
  });

  it("rejects a digest request with an incomplete acceptance map", () => {
    const report = clearReport();
    report.acceptanceMapping = report.acceptanceMapping.slice(0, 1);

    expect(() =>
      calculateIssueReviewReportDigest(report, ["AC-1", "AC-2"], expectation()),
    ).toThrowError(
      expect.objectContaining<Partial<IssueReviewReportError>>({ code: "incomplete_mapping" }),
    );
  });

  it("rejects a digest request bound to a different review identity", () => {
    const report = clearReport();
    report.candidateHead = "f".repeat(40);

    expect(() =>
      calculateIssueReviewReportDigest(report, ["AC-1", "AC-2"], expectation()),
    ).toThrowError(
      expect.objectContaining<Partial<IssueReviewReportError>>({ code: "identity_mismatch" }),
    );
  });

  it("rejects a digest request with duplicate acceptance mappings", () => {
    const report = clearReport();
    report.acceptanceMapping[1] = {
      criterionId: "AC-1",
      status: "satisfied",
      evidence: "test:b proves AC-2.",
    };

    expect(() =>
      calculateIssueReviewReportDigest(report, ["AC-1", "AC-2"], expectation()),
    ).toThrowError(
      expect.objectContaining<Partial<IssueReviewReportError>>({ code: "incomplete_mapping" }),
    );
  });

  it("rejects a digest request with duplicate finding identifiers", () => {
    const report = clearReport();
    report.findings = [finding("src/first.ts"), finding("src/second.ts")];
    report.verdict = "blocked";

    expect(() =>
      calculateIssueReviewReportDigest(report, ["AC-1", "AC-2"], expectation()),
    ).toThrowError(
      expect.objectContaining<Partial<IssueReviewReportError>>({ code: "invalid_schema" }),
    );
  });

  it("accepts a complete finding-free exact-head review", () => {
    const report = parseIssueReviewReport(clearReport(), ["AC-1", "AC-2"], expectation());

    expect(report.verdict).toBe("clear");
    expect(report.acceptanceMapping).toHaveLength(2);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it.each(["P1", "P2", "P3"] as const)("blocks a %s finding", (severity) => {
    const report = clearReport();
    report.findings = [
      {
        id: "finding-1",
        severity,
        category: "correctness",
        file: "src/index.ts",
        startLine: 12,
        endLine: 14,
        summary: "The candidate can accept stale input.",
        evidence: "The guard compares the cached value instead of the frozen value.",
        recommendation: "Compare the frozen identity before accepting the candidate.",
      },
    ];
    report.verdict = "blocked";

    expect(parseIssueReviewReport(report, ["AC-1", "AC-2"], expectation()).verdict).toBe("blocked");
  });

  it("rejects missing, duplicate, unexpected, or unsatisfied acceptance mappings", () => {
    expect(() =>
      parseIssueReviewReport(
        { ...clearReport(), acceptanceMapping: [clearReport().acceptanceMapping[0]] },
        ["AC-1", "AC-2"],
        expectation(),
      ),
    ).toThrow(/complete/i);
    expect(() =>
      parseIssueReviewReport(
        {
          ...clearReport(),
          acceptanceMapping: [
            clearReport().acceptanceMapping[0],
            { ...clearReport().acceptanceMapping[1], criterionId: "AC-1" },
          ],
        },
        ["AC-1", "AC-2"],
        expectation(),
      ),
    ).toThrow(/unique/i);

    const unsatisfied = clearReport();
    unsatisfied.acceptanceMapping[1] = {
      criterionId: "AC-2",
      status: "unsatisfied",
      evidence: "No candidate evidence satisfies AC-2.",
    };
    expect(() => parseIssueReviewReport(unsatisfied, ["AC-1", "AC-2"], expectation())).toThrowError(
      expect.objectContaining<Partial<IssueReviewReportError>>({ code: "inconsistent_verdict" }),
    );
  });

  it("rejects stale heads and verdicts that hide blocking findings", () => {
    expect(() =>
      parseIssueReviewReport(clearReport(), ["AC-1", "AC-2"], {
        ...expectation(),
        candidateHead: "b".repeat(40),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<IssueReviewReportError>>({ code: "identity_mismatch" }),
    );

    const hidden = clearReport();
    hidden.findings = [
      {
        id: "finding-1",
        severity: "P2",
        category: "security",
        file: "src/security.ts",
        startLine: 8,
        summary: "Credentials can enter the child process.",
        evidence: "The complete parent environment is forwarded.",
        recommendation: "Construct a credential-free environment allowlist.",
      },
    ];
    expect(() => parseIssueReviewReport(hidden, ["AC-1", "AC-2"], expectation())).toThrow(
      /verdict/i,
    );
  });

  it("rejects stale issue and substituted review workflow identities", () => {
    expect(() =>
      parseIssueReviewReport(clearReport(), ["AC-1", "AC-2"], {
        ...expectation(),
        issueDigest: "f".repeat(64),
      }),
    ).toThrow(/issue digest/i);
    expect(() =>
      parseIssueReviewReport(clearReport(), ["AC-1", "AC-2"], {
        ...expectation(),
        reviewWorkflowDigest: "f".repeat(64),
      }),
    ).toThrow(/workflow digest/i);
  });

  it.each([
    ["NUL", "src/file\0.ts"],
    ["an ASCII control character", "src/file\u001f.ts"],
    ["DEL", "src/file\u007f.ts"],
    ["NEXT LINE", "src/file\u0085.ts"],
    ["CONTROL SEQUENCE INTRODUCER", "src/file\u009b.ts"],
    ["UTF-8 byte overflow", `${"é".repeat(513)}.ts`],
  ])("rejects a finding file with %s", (_name, file) => {
    const report = clearReport();
    report.findings = [finding(file)];
    report.verdict = "blocked";

    expect(() => parseIssueReviewReport(report, ["AC-1", "AC-2"], expectation())).toThrowError(
      expect.objectContaining<Partial<IssueReviewReportError>>({ code: "invalid_schema" }),
    );
  });
});

function finding(file: string) {
  return {
    id: "finding-1",
    severity: "P2" as const,
    category: "correctness" as const,
    file,
    startLine: 1,
    summary: "The candidate accepts an invalid path.",
    evidence: "The structured finding contains an unsafe file path.",
    recommendation: "Reject the path before accepting the report.",
  };
}

function clearReport(): {
  version: 1;
  candidateHead: string;
  issueDigest: string;
  reviewWorkflowDigest: string;
  acceptanceMapping: Array<{
    criterionId: string;
    status: "satisfied" | "unsatisfied";
    evidence: string;
  }>;
  findings: Array<{
    id: string;
    severity: "P1" | "P2" | "P3";
    category:
      | "security"
      | "correctness"
      | "performance"
      | "reliability"
      | "maintainability"
      | "tests"
      | "documentation";
    file: string;
    startLine: number;
    endLine?: number;
    summary: string;
    evidence: string;
    recommendation: string;
  }>;
  verdict: "clear" | "blocked";
} {
  return {
    version: 1,
    candidateHead: "a".repeat(40),
    issueDigest: "b".repeat(64),
    reviewWorkflowDigest: "c".repeat(64),
    acceptanceMapping: [
      { criterionId: "AC-1", status: "satisfied", evidence: "test:a proves AC-1." },
      { criterionId: "AC-2", status: "satisfied", evidence: "test:b proves AC-2." },
    ],
    findings: [],
    verdict: "clear",
  };
}

function expectation() {
  return {
    candidateHead: "a".repeat(40),
    issueDigest: "b".repeat(64),
    reviewWorkflowDigest: "c".repeat(64),
  };
}
