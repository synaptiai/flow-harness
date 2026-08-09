export type StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | StrictJsonValue[]
  | StrictJsonObject;

export interface StrictJsonObject {
  readonly [key: string]: StrictJsonValue;
}

export type StrictJsonErrorCode = "invalid_json" | "invalid_i_json" | "too_complex";

export class StrictJsonError extends Error {
  override readonly name = "StrictJsonError";

  constructor(
    readonly code: StrictJsonErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface StrictJsonOptions {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly valueLabel?: string;
}

export function parseStrictJson(source: string, options: StrictJsonOptions): StrictJsonValue {
  if (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 1) {
    throw new RangeError("strict JSON maximum depth must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1) {
    throw new RangeError("strict JSON maximum nodes must be a positive safe integer");
  }
  return new StrictJsonParser(source, options).parse();
}

class StrictJsonParser {
  private index = 0;
  private nodes = 0;

  constructor(
    private readonly source: string,
    private readonly options: StrictJsonOptions,
  ) {}

  parse(): StrictJsonValue {
    this.skipWhitespace();
    if (this.index === this.source.length) {
      this.invalid("JSON input is empty");
    }
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.invalid(`unexpected trailing input at offset ${this.index}`);
    }
    return value;
  }

  private parseValue(depth: number): StrictJsonValue {
    if (depth > this.options.maxDepth) {
      this.tooComplex(`depth must not exceed ${this.options.maxDepth}`);
    }
    this.nodes += 1;
    if (this.nodes > this.options.maxNodes) {
      this.tooComplex(`nodes must not exceed ${this.options.maxNodes}`);
    }

    const token = this.source[this.index];
    if (token === '"') {
      return this.parseString();
    }
    if (token === "{") {
      return this.parseObject(depth);
    }
    if (token === "[") {
      return this.parseArray(depth);
    }
    if (token === "t") {
      this.consumeLiteral("true");
      return true;
    }
    if (token === "f") {
      this.consumeLiteral("false");
      return false;
    }
    if (token === "n") {
      this.consumeLiteral("null");
      return null;
    }
    if (token === "-" || isDigit(token)) {
      return this.parseNumber();
    }
    this.invalid(`unexpected token at offset ${this.index}`);
  }

  private parseObject(depth: number): StrictJsonObject {
    this.index += 1;
    this.skipWhitespace();
    const value = Object.create(null) as StrictJsonObject;
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return value;
    }
    while (this.index < this.source.length) {
      if (this.source[this.index] !== '"') {
        this.invalid(`object key must be a JSON string at offset ${this.index}`);
      }
      const key = this.parseString();
      if (keys.has(key)) {
        this.invalid(`duplicate object key ${describeJsonKey(key)}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") {
        this.invalid(`expected ':' after object key at offset ${this.index}`);
      }
      this.index += 1;
      this.skipWhitespace();
      const item = this.parseValue(depth + 1);
      Object.defineProperty(value, key, {
        configurable: false,
        enumerable: true,
        value: item,
        writable: false,
      });
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return value;
      }
      if (delimiter !== ",") {
        this.invalid(`expected ',' or '}' at offset ${this.index}`);
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.invalid("unterminated object");
  }

  private parseArray(depth: number): StrictJsonValue[] {
    this.index += 1;
    this.skipWhitespace();
    const value: StrictJsonValue[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return value;
    }
    while (this.index < this.source.length) {
      value.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return value;
      }
      if (delimiter !== ",") {
        this.invalid(`expected ',' or ']' at offset ${this.index}`);
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.invalid("unterminated array");
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(start, this.index));
        } catch {
          this.invalid(`invalid JSON string at offset ${start}`);
        }
        if (typeof value !== "string") {
          this.invalid(`invalid JSON string at offset ${start}`);
        }
        requireValidUnicode(value);
        return value;
      }
      if (character === "\\") {
        const escapeCode = this.source[this.index + 1];
        if (escapeCode === "u") {
          const code = this.source.slice(this.index + 2, this.index + 6);
          if (!/^[a-fA-F0-9]{4}$/.test(code)) {
            this.invalid(`invalid Unicode escape at offset ${this.index}`);
          }
          this.index += 6;
          continue;
        }
        if (escapeCode === undefined || !'"\\/bfnrt'.includes(escapeCode)) {
          this.invalid(`invalid string escape at offset ${this.index}`);
        }
        this.index += 2;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.invalid(`unescaped control character at offset ${this.index}`);
      }
      this.index += 1;
    }
    this.invalid(`unterminated string at offset ${start}`);
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.source.slice(this.index),
    );
    if (match === null) {
      this.invalid(`invalid number at offset ${this.index}`);
    }
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new StrictJsonError(
        "invalid_i_json",
        `JSON number at offset ${this.index - match[0].length} is not finite IEEE-754`,
      );
    }
    return value;
  }

  private consumeLiteral(literal: "true" | "false" | "null"): void {
    if (!this.source.startsWith(literal, this.index)) {
      this.invalid(`invalid literal at offset ${this.index}`);
    }
    this.index += literal.length;
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") {
        break;
      }
      this.index += 1;
    }
  }

  private invalid(message: string): never {
    throw new StrictJsonError("invalid_json", message);
  }

  private tooComplex(message: string): never {
    throw new StrictJsonError(
      "too_complex",
      `${this.options.valueLabel ?? "JSON value"} ${message}`,
    );
  }
}

function describeJsonKey(key: string): string {
  const characters = [...key];
  if (characters.length <= 96) {
    return JSON.stringify(key);
  }
  return `${JSON.stringify(characters.slice(0, 96).join(""))}…`;
}

function requireValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new StrictJsonError(
          "invalid_i_json",
          "JSON string contains an unpaired high surrogate",
        );
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new StrictJsonError("invalid_i_json", "JSON string contains an unpaired low surrogate");
    }
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}
