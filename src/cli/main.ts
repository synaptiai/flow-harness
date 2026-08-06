#!/usr/bin/env node

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const HELP = `Flow — Provider-neutral harness for evidence-driven software workflows

Usage:
  flow --help
`;

export type OutputWriter = (text: string) => void;

export function main(args: readonly string[], write: OutputWriter = console.log): number {
  try {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: {
          type: "boolean",
          short: "h",
        },
      },
      strict: true,
    });

    if (values.help === true || positionals.length === 0) {
      write(HELP);
      return 0;
    }

    write(`Unknown command "${positionals[0]}"\n\n${HELP}`);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(`${message}\n\n${HELP}`);
    return 2;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
