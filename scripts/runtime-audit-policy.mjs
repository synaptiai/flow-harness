const ADVISORY_PATTERN = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAXIMUM_ALLOWANCE_DAYS = 45;
const DAY_MS = 86_400_000;

/**
 * Evaluate an `npm audit --json` report against exact, expiring allowances.
 *
 * An allowance covers one advisory for one package at one installed node path. Every other
 * finding fails, including derived findings whose vulnerable dependency is not fully allowed.
 * Expired, unused, malformed, or overlong allowances also fail, so exceptions cannot linger.
 */
export function evaluateRuntimeAudit(report, allowances, today) {
  const failures = [];
  const accepted = [];
  const todayMs = parseDate(today, "today");
  const entries = validateAllowances(allowances, todayMs, failures);
  const used = new Set();

  if (!isRecord(report) || report.auditReportVersion !== 2 || !isRecord(report.vulnerabilities)) {
    return { ok: false, failures: ["npm audit did not return a version 2 JSON report"], accepted };
  }
  if (report.error !== undefined) {
    return { ok: false, failures: ["npm audit reported an error instead of findings"], accepted };
  }

  const fullyAllowed = new Map();
  const vulnerabilities = Object.entries(report.vulnerabilities);
  for (const [name, vulnerability] of vulnerabilities) {
    fullyAllowed.set(name, directFindingsAllowed(name, vulnerability, entries, used, accepted));
  }
  for (const [name, vulnerability] of vulnerabilities) {
    if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
      failures.push(`${name}: unrecognized audit entry`);
      continue;
    }
    const direct = vulnerability.via.filter(isRecord);
    const derived = vulnerability.via.filter((item) => typeof item === "string");
    if (
      direct.length + derived.length !== vulnerability.via.length ||
      vulnerability.via.length === 0
    ) {
      failures.push(`${name}: unrecognized audit entry`);
      continue;
    }
    if (direct.length > 0 && fullyAllowed.get(name) !== true) {
      failures.push(`${name}: advisory is not allowed at ${formatNodes(vulnerability.nodes)}`);
    }
    for (const dependency of derived) {
      if (fullyAllowed.get(dependency) !== true) {
        failures.push(`${name}: depends on ${dependency}, which is not fully allowed`);
      }
    }
  }
  for (const entry of entries) {
    if (!used.has(entry.key)) {
      failures.push(`${entry.advisory} at ${entry.path}: allowance is unused; remove it`);
    }
  }
  return { ok: failures.length === 0, failures, accepted };
}

function directFindingsAllowed(name, vulnerability, entries, used, accepted) {
  if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) return false;
  const direct = vulnerability.via.filter(isRecord);
  if (direct.length === 0) return true;
  if (!Array.isArray(vulnerability.nodes) || vulnerability.nodes.length === 0) return false;
  let allowed = true;
  for (const finding of direct) {
    const advisory = advisoryId(finding);
    if (advisory === undefined || finding.name !== name) {
      allowed = false;
      continue;
    }
    for (const path of vulnerability.nodes) {
      const entry = entries.find(
        (candidate) =>
          candidate.advisory === advisory && candidate.package === name && candidate.path === path,
      );
      if (entry === undefined) {
        allowed = false;
      } else {
        used.add(entry.key);
        accepted.push(`${advisory} ${name} at ${path} (expires ${entry.expires})`);
      }
    }
  }
  return allowed;
}

function validateAllowances(allowances, todayMs, failures) {
  if (!isRecord(allowances) || allowances.version !== 1 || !Array.isArray(allowances.allowances)) {
    failures.push("audit allowances must be a version 1 document with an allowances array");
    return [];
  }
  const entries = [];
  const keys = new Set();
  for (const [index, entry] of allowances.allowances.entries()) {
    const label = `allowance ${index + 1}`;
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "advisory,expires,package,path,reason" ||
      typeof entry.advisory !== "string" ||
      !ADVISORY_PATTERN.test(entry.advisory) ||
      typeof entry.package !== "string" ||
      entry.package.length === 0 ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("node_modules/") ||
      !entry.path.endsWith(`node_modules/${entry.package}`) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length < 20 ||
      typeof entry.expires !== "string" ||
      !DATE_PATTERN.test(entry.expires)
    ) {
      failures.push(`${label}: malformed allowance`);
      continue;
    }
    const expiresMs = parseDate(entry.expires, `${label} expiry`);
    if (expiresMs < todayMs) {
      failures.push(`${label}: ${entry.advisory} expired on ${entry.expires}`);
      continue;
    }
    if (expiresMs - todayMs > MAXIMUM_ALLOWANCE_DAYS * DAY_MS) {
      failures.push(`${label}: expiry exceeds ${MAXIMUM_ALLOWANCE_DAYS} days`);
      continue;
    }
    const key = `${entry.advisory}\u0000${entry.package}\u0000${entry.path}`;
    if (keys.has(key)) {
      failures.push(`${label}: duplicate allowance`);
      continue;
    }
    keys.add(key);
    entries.push({ ...entry, key });
  }
  return entries;
}

function advisoryId(finding) {
  if (typeof finding.url !== "string") return undefined;
  const match = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(finding.url);
  return match !== null && ADVISORY_PATTERN.test(match[1]) ? match[1] : undefined;
}

function parseDate(value, label) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new Error(`${label} must be an ISO calendar date`);
  }
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} must be a valid calendar date`);
  }
  return milliseconds;
}

function formatNodes(nodes) {
  return Array.isArray(nodes) && nodes.length > 0 ? nodes.join(", ") : "an unknown path";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
