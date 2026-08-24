import type { CompiledNode } from "../domain/workflow/types.js";
import type {
  AgentCommandExecutor,
  AgentExecutor,
  CommandExecutor,
  LeanProofDriver,
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
} from "./ports.js";
import { VerifierNodeExecutor } from "./verifier-executor.js";

export class NodeExecutorRouter implements NodeExecutor {
  constructor(
    readonly commandExecutor: CommandExecutor,
    readonly agentExecutor: AgentExecutor,
    readonly leanProofDriver?: LeanProofDriver,
  ) {}

  execute(node: CompiledNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    switch (node.type) {
      case "command":
        return this.commandExecutor.execute(node, context);
      case "agent":
        return this.agentExecutor.execute(node, {
          ...context,
          ...(isAgentCommandExecutor(this.commandExecutor)
            ? { agentCommandExecutor: this.commandExecutor }
            : {}),
        });
      case "verifier":
        return new VerifierNodeExecutor(
          this.commandExecutor,
          this.agentExecutor,
          this.leanProofDriver,
        ).execute(node, context);
      case "approval":
      case "child":
      case "result":
      case "condition":
      case "join":
      case "loop-check":
      case "loop":
      case "optimization-check":
      case "optimization":
        throw new Error(`Control node "${node.id}" must be resolved by the workflow scheduler`);
    }
  }
}

function isAgentCommandExecutor(
  executor: CommandExecutor,
): executor is CommandExecutor & AgentCommandExecutor {
  return "executeAgentCommand" in executor && typeof executor.executeAgentCommand === "function";
}
