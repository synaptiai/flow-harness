import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { publicDocumentationFiles } from "./public-documentation-files.mjs";

const properHeadingWords = new Set([
  "ACP",
  "Bun",
  "Docker",
  "Flow",
  "GitHub",
  "JavaScript",
  "Lean",
  "Leanstral",
  "Linux",
  "Node.js",
  "OMP",
  "Pi",
  "Prime",
  "SafeVerify",
  "Sigstore",
  "TUF",
  "TypeBox",
  "Ubuntu",
  "Wasm",
  "YAML",
  "Zod",
  "macOS",
]);
const properHeadingPhrases = [
  "Agent Skill",
  "Agent Skills",
  "Anthropic Sandbox Runtime",
  "Prime Agent",
  "The Update Framework",
];
const argumentsList = process.argv.slice(2);
const root = resolve(readOption(argumentsList, "--root") ?? process.cwd());
const selectedFile = readOption(argumentsList, "--file");
const checkAll = argumentsList.includes("--all");

if ((selectedFile === undefined) === !checkAll) {
  process.stderr.write("Usage: check-doc-style.mjs [--root <path>] (--all | --file <path>)\n");
  process.exit(2);
}

const files = selectedFile === undefined ? await publicDocumentationFiles(root) : [selectedFile];
const issues = [];

for (const file of files) {
  const path = resolve(root, file);
  const displayPath = normalizePath(relative(root, path)) || normalizePath(file);
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    issues.push(`${displayPath}: source does not exist`);
    continue;
  }
  checkDocument(displayPath, source);
}

if (issues.length > 0) {
  process.stderr.write(`DOC_STYLE=${issues.length} issue(s)\n${issues.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("DOC_STYLE=clean\n");

function checkDocument(path, source) {
  const headings = [];
  let fence;
  let inComment = false;

  for (const [index, originalLine] of source.split("\n").entries()) {
    const lineNumber = index + 1;
    const fenceMatch = /^\s*(?<fence>`{3,}|~{3,})/u.exec(originalLine);
    if (fenceMatch?.groups?.fence !== undefined) {
      const marker = fenceMatch.groups.fence[0];
      if (fence === undefined) {
        fence = marker;
      } else if (fence === marker) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      continue;
    }

    const uncommented = removeComments(
      originalLine,
      () => inComment,
      (value) => {
        inComment = value;
      },
    );
    if (uncommented.trim().length === 0) {
      continue;
    }

    const heading = /^(?<marks>#{1,6})\s+(?<text>.+?)\s*#*\s*$/u.exec(uncommented);
    if (heading?.groups?.marks !== undefined && heading.groups.text !== undefined) {
      const level = heading.groups.marks.length;
      headings.push({ level, line: lineNumber, text: heading.groups.text });
      if (!isSentenceCaseHeading(heading.groups.text)) {
        addIssue(path, lineNumber, "heading must use sentence case");
      }
    }

    for (const image of uncommented.matchAll(/!\[(?<alt>[^\]]*)\]\([^)]+\)/gu)) {
      if ((image.groups?.alt ?? "").trim().length === 0) {
        addIssue(path, lineNumber, "informative images require alt text");
      }
    }
    for (const link of uncommented.matchAll(/(?<!!)\[(?<text>[^\]]+)\]\([^)]+\)/gu)) {
      if (
        /^(?:here|click here|this|this link|link|more|learn more)$/iu.test(link.groups?.text ?? "")
      ) {
        addIssue(path, lineNumber, "link text must describe its destination");
      }
    }

    const prose = stripMarkdown(uncommented);
    if (/\b(?:please|simply|obviously|easily|quickly|let's|tl;dr|ymmv)\b/iu.test(prose)) {
      addIssue(path, lineNumber, "avoid this term in direct technical prose");
    }
    if (
      /\b(?:(?:as|described|listed|shown|mentioned|noted)\s+(?:above|below)|(?:above|below)\s+(?:section|table|diagram|figure|list|example|steps?))\b/iu.test(
        prose,
      )
    ) {
      addIssue(
        path,
        lineNumber,
        "use a named cross-reference instead of a directional cross-reference",
      );
    }
    if (prose.includes("&")) {
      addIssue(path, lineNumber, "use 'and' instead of an ampersand in prose");
    }
  }

  if (headings.filter((heading) => heading.level === 1).length !== 1) {
    addIssue(path, 1, "each document must contain exactly one H1");
  }
  let previousLevel = 0;
  for (const heading of headings) {
    if (heading.level > previousLevel + 1) {
      addIssue(path, heading.line, "heading level must not skip a level");
    }
    previousLevel = heading.level;
  }
}

function isSentenceCaseHeading(source) {
  let heading = stripMarkdown(source).replace(/^[^\p{L}\p{N}]+/u, "");
  for (const phrase of properHeadingPhrases) {
    heading = heading.replaceAll(phrase, "product");
  }
  return heading.split(":").every((clause) => {
    const words = clause.match(/[\p{L}\p{N}][\p{L}\p{N}.+-]*/gu) ?? [];
    return words.slice(1).every((word) => {
      if (!/^\p{Lu}\p{Ll}+/u.test(word)) {
        return true;
      }
      return properHeadingWords.has(word);
    });
  });
}

function stripMarkdown(line) {
  return line
    .replace(/`+[^`]*`+/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/<https?:\/\/[^>]+>/gu, " ");
}

function removeComments(line, getState, setState) {
  let value = line;
  if (getState()) {
    const end = value.indexOf("-->");
    if (end < 0) {
      return "";
    }
    value = value.slice(end + 3);
    setState(false);
  }
  while (true) {
    const start = value.indexOf("<!--");
    if (start < 0) {
      return value;
    }
    const end = value.indexOf("-->", start + 4);
    if (end < 0) {
      setState(true);
      return value.slice(0, start);
    }
    value = `${value.slice(0, start)}${value.slice(end + 3)}`;
  }
}

function addIssue(path, line, message) {
  issues.push(`${path}:${line}: ${message}`);
}

function readOption(args, option) {
  const index = args.indexOf(option);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    process.stderr.write(`Missing value for ${option}\n`);
    process.exit(2);
  }
  return value;
}

function normalizePath(path) {
  return path.split(sep).join("/");
}
