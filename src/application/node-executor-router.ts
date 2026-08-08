import type {
  AgentExecutor,
  CommandExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
} from "./ports.js";
import type { CompiledNode } from "../domain/workflow/types.js";
import { VerifierNodeExecutor } from "./verifier-executor.js";

export class NodeExecutorRouter implements NodeExecutor {
  constructor(
    readonly commandExecutor: CommandExecutor,
    readonly agentExecutor: AgentExecutor,
  ) {}

  execute(node: CompiledNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    switch (node.type) {
      case "command":
        return this.commandExecutor.execute(node, context);
      case "agent":
        return this.agentExecutor.execute(node, context);
      case "verifier":
        return new VerifierNodeExecutor(this.commandExecutor, this.agentExecutor).execute(
          node,
          context,
        );
      case "approval":
      case "child":
      case "result":
      case "condition":
      case "join":
      case "loop-check":
      case "loop":
        throw new Error(`Control node "${node.id}" must be resolved by the workflow scheduler`);
    }
  }
}
