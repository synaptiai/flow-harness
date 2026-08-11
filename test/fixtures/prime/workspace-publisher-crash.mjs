import { DurablePrimeWorkspacePublisher } from "../../../dist/infrastructure/oci/durable-prime-workspace-publisher.js";

const [checkpoint, targetRoot, stagingRoot] = process.argv.slice(2);
if (checkpoint === undefined || targetRoot === undefined || stagingRoot === undefined) {
  throw new Error("workspace crash fixture requires checkpoint, target, and staging paths");
}
const crash = () => process.kill(process.pid, "SIGKILL");
const publisher = new DurablePrimeWorkspacePublisher({
  ...(checkpoint === "journal-prepared" ? { afterJournalPrepared: crash } : {}),
  ...(checkpoint === "target-renamed" ? { afterTargetRenamed: crash } : {}),
  ...(checkpoint === "target-retired" ? { afterTargetRetired: crash } : {}),
  ...(checkpoint === "staging-renamed" ? { afterStagingRenamed: crash } : {}),
  ...(checkpoint === "target-switched" ? { afterTargetSwitched: crash } : {}),
  ...(checkpoint === "retired-removed" ? { afterRetiredRemoved: crash } : {}),
});
await publisher.publish({
  targetRoot,
  stagingRoot,
  entries: [
    {
      path: "RESULT.md",
      type: "file",
      mode: 0o644,
      size: 5,
      sha256: "8221ac66be71558c921fb44cfb66f7997699aea754d917763882d6d9eddc836e",
    },
  ],
  manifestSha256: "a".repeat(64),
});
