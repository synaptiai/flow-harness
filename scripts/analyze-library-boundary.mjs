#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repositoryRoot, "src");
const candidateEntries = Object.freeze([
  ["workflow-compiler", "src/domain/workflow/compiler.ts"],
  ["run-event-parser-reducer", "src/domain/run/events.ts"],
  ["workflow-runner", "src/application/run-workflow.ts"],
  ["local-run-store", "src/infrastructure/fs/jsonl-run-store.ts"],
  ["supervisor-service", "src/supervisor/service.ts"],
  ["cli-composition-root", "src/cli/main.ts"],
]);

const productionFiles = await collectTypeScriptFiles(sourceRoot);
const productionFileSet = new Set(productionFiles);
const dependencies = new Map();
const exportCounts = new Map();

for (const path of productionFiles) {
  const source = await readFile(path, "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  exportCounts.set(path, countExportedDeclarations(sourceFile));
  dependencies.set(path, collectStaticDependencies(path, sourceFile, productionFileSet));
}

const layerExportCounts = new Map(
  ["application", "cli", "domain", "infrastructure", "supervisor"].map((layer) => [layer, 0]),
);
for (const [path, count] of exportCounts) {
  const layer = sourceLayer(path);
  layerExportCounts.set(layer, (layerExportCounts.get(layer) ?? 0) + count);
}

const cliSource = await readFile(join(sourceRoot, "cli", "main.ts"), "utf8");
const help = /const HELP = `([\s\S]*?)`;/u.exec(cliSource)?.[1];
if (help === undefined) {
  throw new Error("Flow library-boundary analysis couldn't find the public CLI help.");
}

const report = {
  version: "flow.library-boundary-analysis/v1",
  productionFiles: productionFiles.length,
  exportedDeclarations: {
    total: [...exportCounts.values()].reduce((total, count) => total + count, 0),
    application: layerExportCounts.get("application"),
    cli: layerExportCounts.get("cli"),
    domain: layerExportCounts.get("domain"),
    infrastructure: layerExportCounts.get("infrastructure"),
    supervisor: layerExportCounts.get("supervisor"),
  },
  documentedCliForms: help.split("\n").filter((line) => line.startsWith("  flow ")).length,
  directJsonStdoutSites: countDirectJsonStdoutSites(
    ts.createSourceFile("src/cli/main.ts", cliSource, ts.ScriptTarget.Latest, true),
  ),
  candidates: candidateEntries.map(([id, entry]) => {
    const reachable = collectReachableModules(join(repositoryRoot, entry), dependencies);
    return {
      id,
      entry,
      reachableModules: reachable.size,
      layers: [...new Set([...reachable].map(sourceLayer))].sort(),
    };
  }),
};

process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);

async function collectTypeScriptFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(normalize(path));
    }
  }
  return files;
}

function countExportedDeclarations(sourceFile) {
  let count = 0;
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      count +=
        statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.length
          : 1;
      continue;
    }
    if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      count += ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.length
        : 1;
    }
  }
  return count;
}

function countDirectJsonStdoutSites(sourceFile) {
  let count = 0;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      isPropertyCall(node.expression, "io", "stdout") &&
      node.arguments.length > 0 &&
      ts.isCallExpression(node.arguments[0]) &&
      isPropertyCall(node.arguments[0].expression, "JSON", "stringify")
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function isPropertyCall(expression, owner, property) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === owner &&
    expression.name.text === property
  );
}

function collectStaticDependencies(path, sourceFile, fileSet) {
  const result = new Set();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      const dependency = normalize(
        join(dirname(path), specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : specifier),
      );
      if (fileSet.has(dependency)) result.add(dependency);
    }
  }
  return result;
}

function collectReachableModules(entry, graph) {
  const pending = [normalize(entry)];
  const reachable = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || reachable.has(path)) continue;
    if (!graph.has(path)) {
      throw new Error(`Flow library-boundary analysis entry is missing: ${repositoryPath(path)}`);
    }
    reachable.add(path);
    pending.push(...(graph.get(path) ?? []));
  }
  return reachable;
}

function sourceLayer(path) {
  const segments = repositoryPath(path).split("/");
  if (segments[0] !== "src" || segments[1] === undefined) {
    throw new Error("Flow library-boundary analysis found a source outside src.");
  }
  return segments[1];
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}
