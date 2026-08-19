import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const publicDocumentationDirectories = [".github", "docs", "examples"];

export async function publicDocumentationFiles(repositoryRoot) {
  const rootFiles = (await readdir(repositoryRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name);
  const nestedFiles = await Promise.all(
    publicDocumentationDirectories.map((directory) =>
      markdownFiles(repositoryRoot, join(repositoryRoot, directory)),
    ),
  );
  return [...rootFiles, ...nestedFiles.flat()].sort();
}

async function markdownFiles(repositoryRoot, directoryPath) {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const paths = [];
  for (const entry of entries) {
    const path = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await markdownFiles(repositoryRoot, path)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const repositoryPath = normalizePath(relative(repositoryRoot, path));
    if (!isExecutableEvaluationArtifact(repositoryPath)) {
      paths.push(repositoryPath);
    }
  }
  return paths;
}

function isExecutableEvaluationArtifact(path) {
  return /^examples\/evaluation\/(?:.*\/)?(?:RESULT|TASK)\.md$/u.test(path);
}

function normalizePath(path) {
  return path.split(sep).join("/");
}
