import { z } from "zod";

export const MAX_AGENT_SKILL_PACKAGES = 32;

export const agentSkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
