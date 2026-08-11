import { createHash, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ExternalHarnessProtocolSession,
  signExternalHarnessParentFrame,
} from "../../domain/evaluation/external-harness-protocol.js";
import type { EvaluationHarnessOutcome } from "../../domain/evaluation/records.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import {
  createPrimeContainerReadinessChallenge,
  encodePrimeContainerFrame,
  type PrimeContainerFrame,
  PrimeContainerFrameDecoder,
  PrimeContainerFrameType,
  type PrimeContainerManifestEntry,
  PrimeContainerProtocolSequence,
  type PrimeContainerTransferStart,
  PrimeContainerTransferValidator,
  parsePrimeContainerManifestEntryPayload,
  parsePrimeContainerTransferStartPayload,
} from "../prime/prime-container-protocol.js";
import { PrimeEvaluationMetricsLedger } from "../prime/prime-evaluation-metrics.js";
import type { ExternalHarnessInferenceBroker } from "../process/local-external-harness-runtime.js";
import type {
  PrimeOciOperationEvidence,
  PrimeOciOperationInput,
} from "./local-prime-oci-harness-runtime.js";

const settlementSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255).nullable(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    activeTimeMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    kernelRequests: z.number().int().min(0).max(1),
  })
  .strict()
  .superRefine((settlement, context) => {
    if (settlement.timedOut && settlement.aborted) {
      context.addIssue({
        code: "custom",
        path: ["aborted"],
        message: "Prime OCI settlement cannot be both timed out and aborted",
      });
    }
  });

type HarnessWithoutRuntime<T> = T extends unknown ? Omit<T, "runtime"> : never;
type PrimeHarnessWithoutRuntime = HarnessWithoutRuntime<EvaluationHarnessOutcome>;

export type PrimeOciFixturePart =
  | { readonly type: "entry"; readonly entry: PrimeContainerManifestEntry }
  | { readonly type: "chunk"; readonly bytes: Uint8Array }
  | { readonly type: "file-end" };

export interface PrimeOciFixtureSource {
  readonly start: PrimeContainerTransferStart;
  readonly instructionText: string;
  parts(signal?: AbortSignal): AsyncIterable<PrimeOciFixturePart>;
}

export interface PrimeOciResultSink {
  begin(start: PrimeContainerTransferStart, signal?: AbortSignal): Promise<void>;
  addEntry(entry: PrimeContainerManifestEntry, signal?: AbortSignal): Promise<void>;
  addChunk(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  endFile(signal?: AbortSignal): Promise<void>;
  commit(entries: readonly PrimeContainerManifestEntry[], signal?: AbortSignal): Promise<void>;
  abort(error: unknown): Promise<void>;
}

export interface PrimeOciAttachedTransport {
  readonly output: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  closeInput(signal?: AbortSignal): Promise<void>;
  release(): Promise<void>;
}

export interface AttachedPrimeOciOperatorOptions {
  readonly fixture: PrimeOciFixtureSource;
  readonly resultSink: PrimeOciResultSink;
  readonly inferenceBroker: ExternalHarnessInferenceBroker;
  readonly validateReadiness: (
    payload: Uint8Array,
    input: PrimeOciOperationInput,
  ) => void | Promise<void>;
  readonly sessionIdFactory?: () => string;
  readonly secretHexFactory?: () => string;
}

export class AttachedPrimeOciOperator {
  constructor(private readonly options: AttachedPrimeOciOperatorOptions) {}

  async operate(input: PrimeOciOperationInput): Promise<PrimeOciOperationEvidence> {
    const sessionId = (this.options.sessionIdFactory ?? randomUUID)();
    const secretHex = (this.options.secretHexFactory ?? (() => randomBytes(32).toString("hex")))();
    const session = new ExternalHarnessProtocolSession({
      sessionId,
      secretHex,
      trialId: input.request.evaluation.trial.trialId,
      identityDigest: input.descriptor.identityDigest,
    });
    const sequence = new PrimeContainerProtocolSequence();
    const decoder = new PrimeContainerFrameDecoder();
    const ledger = new PrimeEvaluationMetricsLedger({
      maxModelTurns: input.request.identity.outerProtocol.maxModelTurns,
      maxIpythonCalls: input.request.identity.outerProtocol.maxIpythonCalls,
    });
    let parentSequence = 1;
    let terminal: PrimeHarnessWithoutRuntime | undefined;
    let resultValidator: PrimeContainerTransferValidator | undefined;
    let resultCommitted = false;
    let activeTimeMicros: number | null = null;
    let settlement:
      | {
          readonly exitCode: number | null;
          readonly timedOut: boolean;
          readonly aborted: boolean;
          readonly kernelRequests: number;
        }
      | undefined;
    let operationError: unknown;

    try {
      await this.#send(
        sequence,
        input.transport,
        PrimeContainerFrameType.AttestationChallenge,
        Buffer.from(
          JSON.stringify(
            createPrimeContainerReadinessChallenge({
              version: 1,
              containerId: input.containerId,
              trialId: input.request.evaluation.trial.trialId,
              identityDigest: input.descriptor.identityDigest,
              imageId: input.request.identity.image.id,
              policyDigest: input.request.identity.runtime.policy.digest,
            }),
          ),
        ),
        input.signal,
      );
      for await (const bytes of input.transport.output) {
        throwIfAborted(input.signal);
        for (const frame of decoder.push(bytes)) {
          sequence.accept("container-to-host", frame.type, frame.payload.byteLength);
          switch (frame.type) {
            case PrimeContainerFrameType.Readiness:
              await this.options.validateReadiness(frame.payload, input);
              await this.#sendFixture(sequence, input.transport, input.signal);
              await this.#sendBootstrap(
                sequence,
                input.transport,
                input,
                sessionId,
                secretHex,
                parentSequence,
              );
              parentSequence += 1;
              break;
            case PrimeContainerFrameType.Driver: {
              const event = session.acceptDriverLine(decodeUtf8(frame.payload, "driver frame"));
              if (event.type === "inference_request") {
                const body = await this.options.inferenceBroker.infer(
                  {
                    identity: input.request.identity,
                    evaluation: input.request.evaluation,
                    requestId: event.requestId,
                    body: event.body,
                  },
                  input.signal,
                );
                ledger.recordBrokerResponse(body);
                await this.#send(
                  sequence,
                  input.transport,
                  PrimeContainerFrameType.Driver,
                  Buffer.from(
                    JSON.stringify(
                      signExternalHarnessParentFrame(
                        {
                          version: 1,
                          sequence: parentSequence,
                          sessionId,
                          type: "inference_response",
                          payload: {
                            requestId: event.requestId,
                            body,
                            bodySha256: sha256(body),
                          },
                        },
                        secretHex,
                      ),
                    ),
                  ),
                  input.signal,
                );
                parentSequence += 1;
                session.completeInference(event.requestId);
              } else if (event.type === "terminal") {
                if (event.harness.runtime !== undefined) {
                  throw new Error("Prime child terminal evidence cannot assert host runtime state");
                }
                const { runtime: _runtime, ...harness } = event.harness;
                terminal = harness as PrimeHarnessWithoutRuntime;
                ledger.reconcileTerminalMetrics(event.metrics);
              }
              break;
            }
            case PrimeContainerFrameType.Terminal:
              assertEmpty(frame);
              if (terminal === undefined) {
                throw new Error("Prime outer terminal has no authenticated driver terminal");
              }
              await input.checkpoint("terminal");
              break;
            case PrimeContainerFrameType.ResultStart: {
              const start = parsePrimeContainerTransferStartPayload(frame.payload);
              resultValidator = new PrimeContainerTransferValidator(start);
              await this.options.resultSink.begin(start, input.signal);
              break;
            }
            case PrimeContainerFrameType.ResultEntry: {
              const validator = requireResultValidator(resultValidator);
              const entry = parsePrimeContainerManifestEntryPayload(frame.payload);
              validator.addEntry(entry);
              await this.options.resultSink.addEntry(entry, input.signal);
              break;
            }
            case PrimeContainerFrameType.ResultChunk: {
              const validator = requireResultValidator(resultValidator);
              validator.addChunk(frame.payload);
              await this.options.resultSink.addChunk(frame.payload, input.signal);
              break;
            }
            case PrimeContainerFrameType.ResultFileEnd: {
              assertEmpty(frame);
              const validator = requireResultValidator(resultValidator);
              validator.endFile();
              await this.options.resultSink.endFile(input.signal);
              break;
            }
            case PrimeContainerFrameType.ResultComplete: {
              assertEmpty(frame);
              const entries = requireResultValidator(resultValidator).complete();
              await this.options.resultSink.commit(entries, input.signal);
              resultCommitted = true;
              await input.checkpoint("exported");
              break;
            }
            case PrimeContainerFrameType.Settlement: {
              if (!resultCommitted) {
                throw new Error("Prime OCI settlement arrived before result publication");
              }
              const parsed = settlementSchema.safeParse(parseJson(frame.payload, "settlement"));
              if (!parsed.success) {
                throw new Error("Prime OCI settlement violates the closed schema", {
                  cause: parsed.error,
                });
              }
              activeTimeMicros = parsed.data.activeTimeMicros;
              settlement = {
                exitCode: parsed.data.exitCode,
                timedOut: parsed.data.timedOut,
                aborted: parsed.data.aborted,
                kernelRequests: parsed.data.kernelRequests,
              };
              break;
            }
            default:
              throw new Error(`Prime container sent invalid frame type ${String(frame.type)}`);
          }
        }
      }
      decoder.finish();
      sequence.finish();
      if (terminal === undefined || settlement === undefined) {
        throw new Error("Prime OCI operation ended without terminal evidence and settlement");
      }
    } catch (error) {
      operationError = error;
      ledger.markTranscriptIncomplete();
      ledger.markLifecycleIncomplete();
    }

    let cleanupError: unknown;
    if (operationError !== undefined && !resultCommitted) {
      try {
        await this.options.resultSink.abort(operationError);
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await input.transport.closeInput(input.signal);
    } catch (error) {
      cleanupError = combineErrors(cleanupError, error);
    }
    try {
      const closePromise = this.options.inferenceBroker.close?.(input.request.evaluation);
      if (closePromise !== undefined) {
        await waitForAbortable(closePromise, input.signal);
      }
    } catch (error) {
      cleanupError = combineErrors(cleanupError, error);
    }
    if (operationError !== undefined || cleanupError !== undefined) {
      throw combineErrors(operationError, cleanupError);
    }

    const completedTerminal = terminal;
    const completedSettlement = settlement;
    if (completedTerminal === undefined || completedSettlement === undefined) {
      throw new Error("Prime OCI operation did not produce complete evidence");
    }
    return Object.freeze({
      harness: Object.freeze(completedTerminal),
      settlement: Object.freeze(completedSettlement),
      finishMetrics: ({
        startedAtMs,
        endedAtMs,
      }: {
        readonly startedAtMs: number;
        readonly endedAtMs: number;
      }) => ledger.finish({ startedAtMs, endedAtMs, activeTimeMicros }),
    });
  }

  async #sendFixture(
    sequence: PrimeContainerProtocolSequence,
    transport: PrimeOciAttachedTransport,
    signal?: AbortSignal,
  ): Promise<void> {
    const validator = new PrimeContainerTransferValidator(this.options.fixture.start);
    await this.#send(
      sequence,
      transport,
      PrimeContainerFrameType.FixtureStart,
      Buffer.from(JSON.stringify(this.options.fixture.start)),
      signal,
    );
    for await (const part of this.options.fixture.parts(signal)) {
      throwIfAborted(signal);
      if (part.type === "entry") {
        validator.addEntry(part.entry);
        await this.#send(
          sequence,
          transport,
          PrimeContainerFrameType.FixtureEntry,
          Buffer.from(JSON.stringify(part.entry)),
          signal,
        );
      } else if (part.type === "chunk") {
        validator.addChunk(part.bytes);
        await this.#send(
          sequence,
          transport,
          PrimeContainerFrameType.FixtureChunk,
          part.bytes,
          signal,
        );
      } else {
        validator.endFile();
        await this.#send(
          sequence,
          transport,
          PrimeContainerFrameType.FixtureFileEnd,
          Buffer.alloc(0),
          signal,
        );
      }
    }
    validator.complete();
    await this.#send(
      sequence,
      transport,
      PrimeContainerFrameType.FixtureComplete,
      Buffer.alloc(0),
      signal,
    );
  }

  async #sendBootstrap(
    sequence: PrimeContainerProtocolSequence,
    transport: PrimeOciAttachedTransport,
    input: PrimeOciOperationInput,
    sessionId: string,
    secretHex: string,
    parentSequence: number,
  ): Promise<void> {
    const { durability: _durability, ...evaluation } = input.request.evaluation;
    const containerEvaluation = {
      ...evaluation,
      workspace: {
        ...evaluation.workspace,
        cwd: "/workspace",
      },
    };
    const hello = signExternalHarnessParentFrame(
      {
        version: 1,
        sequence: parentSequence,
        sessionId,
        type: "hello",
        payload: {
          secretHex,
          trialId: input.request.evaluation.trial.trialId,
          identityDigest: input.descriptor.identityDigest,
          evaluation: containerEvaluation,
          instructionText: this.options.fixture.instructionText,
        },
      },
      secretHex,
    );
    await this.#send(
      sequence,
      transport,
      PrimeContainerFrameType.Bootstrap,
      Buffer.from(JSON.stringify(hello)),
      input.signal,
    );
  }

  async #send(
    sequence: PrimeContainerProtocolSequence,
    transport: PrimeOciAttachedTransport,
    type: PrimeContainerFrameType,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    sequence.accept("host-to-container", type, payload.byteLength);
    await transport.write(encodePrimeContainerFrame(type, payload), signal);
  }
}

function requireResultValidator(
  validator: PrimeContainerTransferValidator | undefined,
): PrimeContainerTransferValidator {
  if (validator === undefined) {
    throw new Error("Prime result transfer has no start frame");
  }
  return validator;
}

function assertEmpty(frame: PrimeContainerFrame): void {
  if (frame.payload.byteLength !== 0) {
    throw new Error(`Prime container frame type ${String(frame.type)} must have an empty payload`);
  }
}

function decodeUtf8(payload: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (error) {
    throw new Error(`Prime container ${label} is not valid UTF-8`, { cause: error });
  }
}

function parseJson(payload: Uint8Array, label: string): unknown {
  try {
    return parseStrictJson(decodeUtf8(payload, label), {
      maxDepth: 8,
      maxNodes: 64,
      valueLabel: `Prime OCI ${label}`,
    });
  } catch (error) {
    throw new Error(`Prime OCI ${label} is not strict JSON`, { cause: error });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Prime OCI operation aborted");
  }
}

async function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Prime OCI operation aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function combineErrors(primary: unknown, secondary: unknown): unknown {
  if (primary === undefined) {
    return secondary;
  }
  if (secondary === undefined) {
    return primary;
  }
  return new AggregateError([primary, secondary], "Prime OCI operation and cleanup both failed");
}
