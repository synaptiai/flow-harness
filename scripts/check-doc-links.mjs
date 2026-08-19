import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { publicDocumentationFiles } from "./public-documentation-files.mjs";

const argumentsList = process.argv.slice(2);
const root = resolve(readOption(argumentsList, "--root") ?? process.cwd());
const selectedFile = readOption(argumentsList, "--file");
const checkAll = argumentsList.includes("--all");

if ((selectedFile === undefined) === !checkAll) {
  process.stderr.write("Usage: check-doc-links.mjs [--root <path>] (--all | --file <path>)\n");
  process.exit(2);
}

const files = selectedFile === undefined ? await publicDocumentationFiles(root) : [selectedFile];
const issues = [];
const anchorsByPath = new Map();

for (const file of files) {
  const sourcePath = resolve(root, file);
  if (!isWithin(root, sourcePath)) {
    issues.push(`${normalizePath(file)}: target leaves repository`);
    continue;
  }
  let source;
  try {
    source = await readFile(sourcePath, "utf8");
  } catch {
    issues.push(`${normalizePath(file)}: source does not exist`);
    continue;
  }

  for (const link of markdownLinks(source)) {
    const target = link.target;
    if (isExternalTarget(target)) {
      continue;
    }

    const { path, anchor } = splitTarget(target);
    const decodedPath = decodeTarget(path);
    if (decodedPath === undefined) {
      issues.push(`${normalizePath(file)}:${link.line}: target is not valid URL encoding`);
      continue;
    }

    const targetPath =
      decodedPath.length === 0
        ? sourcePath
        : isAbsolute(decodedPath)
          ? resolve(root, `.${decodedPath}`)
          : resolve(dirname(sourcePath), decodedPath);
    if (!isWithin(root, targetPath)) {
      issues.push(`${normalizePath(file)}:${link.line}: target leaves repository: ${target}`);
      continue;
    }

    let targetStat;
    try {
      targetStat = await lstat(targetPath);
    } catch {
      issues.push(`${normalizePath(file)}:${link.line}: target does not exist: ${target}`);
      continue;
    }
    if (!targetStat.isFile()) {
      issues.push(`${normalizePath(file)}:${link.line}: target is not a regular file: ${target}`);
      continue;
    }

    if (anchor === undefined || anchor.length === 0 || !targetPath.endsWith(".md")) {
      continue;
    }

    let anchors = anchorsByPath.get(targetPath);
    if (anchors === undefined) {
      anchors = await markdownAnchors(targetPath);
      anchorsByPath.set(targetPath, anchors);
    }
    const decodedAnchor = decodeTarget(anchor);
    if (decodedAnchor === undefined || !anchors.has(decodedAnchor.toLowerCase())) {
      issues.push(`${normalizePath(file)}:${link.line}: anchor does not exist: ${target}`);
    }
  }
}

if (issues.length > 0) {
  process.stderr.write(`DOC_LINKS=${issues.length} issue(s)\n${issues.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("DOC_LINKS=clean\n");

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

function markdownLinks(source) {
  const links = [];
  let fence;
  for (const [index, originalLine] of source.split("\n").entries()) {
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

    const line = originalLine.replace(/`+[^`]*`+/gu, "");
    for (const match of line.matchAll(/!?\[[^\]]*\]\((?<value>[^)]+)\)/gu)) {
      const value = linkValue(match.groups?.value ?? "");
      if (value.length > 0) {
        links.push({ line: index + 1, target: value });
      }
    }
    const definition = /^\s*\[[^\]]+\]:\s*(?<value>\S+)/u.exec(line);
    if (definition?.groups?.value !== undefined) {
      links.push({ line: index + 1, target: linkValue(definition.groups.value) });
    }
  }
  return links;
}

function linkValue(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    return end < 0 ? value : value.slice(1, end);
  }
  return value.split(/\s+/u, 1)[0] ?? "";
}

function isExternalTarget(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target);
}

function splitTarget(target) {
  const index = target.indexOf("#");
  return index < 0
    ? { path: target, anchor: undefined }
    : { path: target.slice(0, index), anchor: target.slice(index + 1) };
}

function decodeTarget(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function isWithin(repositoryRoot, path) {
  const relativePath = relative(repositoryRoot, path);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

async function markdownAnchors(path) {
  const source = await readFile(path, "utf8");
  const anchors = new Set();
  const counts = new Map();
  let fence;
  for (const line of source.split("\n")) {
    const fenceMatch = /^\s*(?<fence>`{3,}|~{3,})/u.exec(line);
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
    const heading = /^#{1,6}\s+(?<text>.+?)\s*#*\s*$/u.exec(line)?.groups?.text;
    if (heading === undefined) {
      continue;
    }
    const base = githubHeadingSlug(heading);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function githubHeadingSlug(heading) {
  return heading
    .replace(/<[^>]*>/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function normalizePath(path) {
  return path.split(sep).join("/");
}
