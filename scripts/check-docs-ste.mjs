import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const argumentsList = process.argv.slice(2);
const findings = [];
const bannedPatterns = [
  /\b(?:seamless|robust|powerful|cutting-edge|effortless|world-class|next-generation|revolutionary|blazing(?:-fast)?|lightning-fast|elegant|delightful|turnkey|best-in-class|state-of-the-art|game-changing|first-class|battle-tested|enterprise-grade|supercharged?|unlock|unleash|empowering?|innovative|industry-leading|transformative)\b/i,
  /\b(?:spin up|spin down|spun up|reach out|reaching out|dive into|diving into|kick off|roll out|tear down|ramp up|circle back|drill down|drill into|sync up|touch base|zero in on)\b/i,
  /\b(?:it is important to note that|it should be noted that|it is worth noting that|please note that|as previously mentioned|as mentioned above|as noted above|needless to say|at this point in time|due to the fact that|in the event that|for all intents and purposes)\b/i,
  /\b(?:utilize|leverage|facilitate|ensure|commence|initiate|originate|prior to|subsequent to|regarding|concerning|obtain|acquire|demonstrate|additionally|furthermore|moreover|henceforth|therein|whilst|amongst|numerous|myriad|plethora|in order to|a variety of|endeavor|ascertain)\b/i,
];

if (argumentsList[0] === "--file" && argumentsList.length === 2) {
  const path = resolve(argumentsList[1]);
  checkProse(path, await readFile(path, "utf8"));
} else if (argumentsList[0] === "--changed" && argumentsList.length === 1) {
  await checkChangedProse();
} else {
  process.stderr.write("Usage: check-docs-ste.mjs --changed | --file <path>\n");
  process.exitCode = 2;
}

if (process.exitCode === undefined) {
  if (findings.length === 0) {
    process.stdout.write("PROSE_LINT=clean\n");
  } else {
    process.stderr.write(`PROSE_LINT=${findings.length} hard violation(s)\n`);
    for (const finding of findings) {
      process.stderr.write(`${finding.path}:${finding.line} ${finding.category}\n`);
    }
    process.exitCode = 1;
  }
}

async function checkChangedProse() {
  const base = await resolveDiffBase();
  const committed = await git(["diff", "--unified=0", "--no-ext-diff", base, "--", "*.md"]);
  checkAddedDiff(committed);
  const untracked = (
    await git(["ls-files", "--others", "--exclude-standard", "--", "docs/*.md", "docs/**/*.md"])
  )
    .split("\n")
    .filter(Boolean);
  for (const path of untracked) {
    checkProse(path, await readFile(path, "utf8"));
  }
}

async function resolveDiffBase() {
  const candidates = [
    process.env.GITHUB_BASE_REF === undefined ? undefined : `origin/${process.env.GITHUB_BASE_REF}`,
    "origin/main",
    "HEAD^",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return (await git(["merge-base", candidate, "HEAD"])).trim();
    } catch {}
  }
  throw new Error("The STE gate cannot find a Git comparison base");
}

function checkAddedDiff(source) {
  let path = "unknown.md";
  let addedLine = 0;
  const added = [];
  for (const line of source.split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(?<line>\d+)(?:,\d+)? @@/.exec(line);
    if (hunk?.groups?.line !== undefined) {
      addedLine = Number(hunk.groups.line);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ path, line: addedLine, text: line.slice(1) });
      addedLine += 1;
    } else if (!line.startsWith("-")) {
      addedLine += 1;
    }
  }
  checkLines(added);
}

function checkProse(path, source) {
  checkLines(source.split("\n").map((text, index) => ({ path, line: index + 1, text })));
}

function checkLines(lines) {
  let inFence = false;
  let paragraph = [];
  let previousPath;
  let previousLine;
  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const source = paragraph.map((part) => part.prose).join(" ");
    const strict = paragraph.some((part) => part.strict);
    const cap = strict ? 20 : 25;
    const sentences = source
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      if (isHedgeMarker(sentence)) {
        continue;
      }
      const words = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
      if (words.length > cap) {
        addFinding(paragraph.at(-1).entry, `sentence has ${words.length} words and exceeds ${cap}`);
      }
    }
    if (sentences.length > 6) {
      addFinding(paragraph.at(-1).entry, "paragraph has more than six sentences");
    }
    paragraph = [];
  };
  for (const entry of lines) {
    if (
      previousPath !== undefined &&
      (entry.path !== previousPath || entry.line !== previousLine + 1)
    ) {
      flushParagraph();
    }
    previousPath = entry.path;
    previousLine = entry.line;
    const trimmed = entry.text.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      inFence = !inFence;
      continue;
    }
    if (inFence || shouldSkip(trimmed)) {
      flushParagraph();
      continue;
    }
    const prose = stripMarkup(entry.text);
    if (prose.includes(";")) {
      addFinding(entry, "semicolon");
    }
    for (const pattern of bannedPatterns) {
      if (pattern.test(prose)) {
        addFinding(entry, "prohibited vocabulary");
      }
    }
    paragraph.push({
      entry,
      prose,
      strict: /^\s*(?:[-*]|\d+[.)])\s+/.test(entry.text),
    });
  }
  flushParagraph();
}

function shouldSkip(line) {
  return (
    line.length === 0 ||
    line.startsWith("#") ||
    line.startsWith("|") ||
    line.startsWith("<!--") ||
    line === "---" ||
    /^[A-Za-z0-9_-]+:\s/.test(line)
  );
}

function stripMarkup(line) {
  return line
    .replace(/`[^`]*`/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
    .trim();
}

function isHedgeMarker(sentence) {
  return /^(?:This suggests|The most likely reading is|Inferred from|Inferred:|Unknown:|Recommendation:)/i.test(
    sentence,
  );
}

function addFinding(entry, category) {
  const key = `${entry.path}:${entry.line}:${category}`;
  if (!findings.some((finding) => finding.key === key)) {
    findings.push({ ...entry, category, key });
  }
}

async function git(args) {
  const result = await execute("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}
