export function encodePosixCommand(executable: string, args: readonly string[]): string {
  if (executable.length === 0) {
    throw new TypeError("executable must not be empty");
  }

  return [executable, ...args].map(quotePosixValue).join(" ");
}

function quotePosixValue(value: string): string {
  if (value.includes("\0")) {
    throw new TypeError("command values must not contain NUL bytes");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
