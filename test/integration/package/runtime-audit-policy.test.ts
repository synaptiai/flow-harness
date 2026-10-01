import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateRuntimeAudit } from "../../../scripts/runtime-audit-policy.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const nestedPath = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
const today = "2026-10-01";

function advisory(id: string, name = "brace-expansion") {
  return { source: 1, name, url: `https://github.com/advisories/${id}`, severity: "high" };
}

function report(vulnerabilities: Record<string, unknown>) {
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

function braceFinding(nodes = [nestedPath]) {
  return {
    name: "brace-expansion",
    via: [advisory("GHSA-q2hr-2g5m-vwhr"), advisory("GHSA-qhr7-859c-m2p7")],
    nodes,
  };
}

function allowances(overrides: Record<string, unknown>[] = []) {
  const base = ["GHSA-q2hr-2g5m-vwhr", "GHSA-qhr7-859c-m2p7"].map((id) => ({
    advisory: id,
    package: "brace-expansion",
    path: nestedPath,
    expires: "2026-10-30",
    reason: "Pinned by an upstream shrinkwrap that overrides cannot replace.",
  }));
  return { version: 1, allowances: overrides.length === 0 ? base : overrides };
}

describe("runtime audit policy", () => {
  it("passes a clean report with no allowances", () => {
    expect(evaluateRuntimeAudit(report({}), { version: 1, allowances: [] }, today)).toEqual({
      ok: true,
      failures: [],
      accepted: [],
    });
  });

  it("accepts only exact advisory, package, and path matches", () => {
    const result = evaluateRuntimeAudit(
      report({ "brace-expansion": braceFinding() }),
      allowances(),
      today,
    );
    expect(result.ok).toBe(true);
    expect(result.accepted).toHaveLength(2);
  });

  it("rejects the same advisory at an unallowed path", () => {
    const result = evaluateRuntimeAudit(
      report({ "brace-expansion": braceFinding([nestedPath, "node_modules/brace-expansion"]) }),
      allowances(),
      today,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("not allowed");
  });

  it("rejects an advisory that has no allowance", () => {
    const finding = braceFinding();
    finding.via.push(advisory("GHSA-6j4f-fj2g-mc7p"));
    const result = evaluateRuntimeAudit(
      report({ "brace-expansion": finding }),
      allowances(),
      today,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects any other vulnerable package", () => {
    const result = evaluateRuntimeAudit(
      report({
        "brace-expansion": braceFinding(),
        undici: {
          name: "undici",
          via: [advisory("GHSA-3wwx-pv8p-q78v", "undici")],
          nodes: ["node_modules/undici"],
        },
      }),
      allowances(),
      today,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("undici");
  });

  it("rejects derived findings whose vulnerable dependency is not fully allowed", () => {
    const result = evaluateRuntimeAudit(
      report({
        minimatch: {
          name: "minimatch",
          via: ["brace-expansion"],
          nodes: ["node_modules/minimatch"],
        },
        "brace-expansion": braceFinding([nestedPath, "node_modules/brace-expansion"]),
      }),
      allowances(),
      today,
    );
    expect(result.failures.join("\n")).toContain("minimatch: depends on brace-expansion");
  });

  it("accepts derived findings when their vulnerable dependency is fully allowed", () => {
    const result = evaluateRuntimeAudit(
      report({
        minimatch: {
          name: "minimatch",
          via: ["brace-expansion"],
          nodes: ["node_modules/minimatch"],
        },
        "brace-expansion": braceFinding(),
      }),
      allowances(),
      today,
    );
    expect(result.ok).toBe(true);
  });

  it("fails expired, overlong, unused, duplicate, and malformed allowances", () => {
    const [base] = allowances().allowances;
    if (base === undefined) throw new Error("missing base allowance");
    const cases = [
      { ...base, expires: "2026-09-30" },
      { ...base, expires: "2026-12-31" },
      { ...base, advisory: "GHSA-6j4f-fj2g-mc7p" },
      { ...base, reason: "short" },
      { ...base, path: "node_modules/other" },
      { ...base, extra: true },
    ];
    for (const entry of cases) {
      const result = evaluateRuntimeAudit(report({}), allowances([entry]), today);
      expect(result.ok, JSON.stringify(entry)).toBe(false);
    }
    const duplicate = evaluateRuntimeAudit(
      report({ "brace-expansion": braceFinding() }),
      allowances([...allowances().allowances, base]),
      today,
    );
    expect(duplicate.failures.join("\n")).toContain("duplicate");
  });

  it("fails reports that are not npm audit version 2 findings", () => {
    for (const input of [
      null,
      {},
      { auditReportVersion: 1, vulnerabilities: {} },
      { ...report({}), error: {} },
    ]) {
      expect(evaluateRuntimeAudit(input, allowances(), today).ok).toBe(false);
    }
    expect(
      evaluateRuntimeAudit(
        report({ x: { name: "x", via: [], nodes: [] } }),
        { version: 1, allowances: [] },
        today,
      ).ok,
    ).toBe(false);
  });

  it("keeps the committed allowances exact and short-lived", async () => {
    const committed = JSON.parse(
      await readFile(resolve(repositoryRoot, "scripts/runtime-audit-allowances.json"), "utf8"),
    ) as { allowances: { path: string; expires: string }[] };
    for (const entry of committed.allowances) {
      expect(entry.path).toBe(nestedPath);
      expect(entry.expires <= "2026-10-30").toBe(true);
    }
  });
});
