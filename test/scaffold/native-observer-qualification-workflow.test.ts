import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("native observer qualification workflow", () => {
  it("isolates the native feedback branch from full CI and privileged events", async () => {
    const source = await readFile(
      new URL("../../.github/workflows/native-observer-qualification.yml", import.meta.url),
      "utf8",
    );
    const workflow = parse(source);
    expect(workflow.on).toEqual({
      push: { branches: ["codex/issue-197-native-qualification"] },
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert literal GitHub expression syntax, not JavaScript interpolation.
      group: "native-observer-qualification-${{ github.ref }}",
      "cancel-in-progress": false,
    });
    expect(Object.keys(workflow.jobs)).toEqual(["native-observer-development"]);
    const job = workflow.jobs["native-observer-development"];
    expect(job.name).toBe("Native observer development (not full CI)");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.steps[0].with["persist-credentials"]).toBe(false);
    expect(
      job.steps
        .filter((step: { uses?: string }) => step.uses)
        .map((step: { uses: string }) => step.uses),
    ).toEqual([
      "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    ]);
    expect(source).not.toMatch(
      /secrets\.|id-token|continue-on-error|pull_request_target|workflow_run/,
    );
    const commands = job.steps.flatMap((step: { run?: string }) => step.run ?? []).join("\n");
    expect(commands).toContain('test "$(uname -m)" = x86_64');
    expect(commands).toContain('test "$(uname -s)" = Linux');
    expect(commands).toContain("npm ci --ignore-scripts");
    expect(commands).toContain("realpath /usr/bin/socat");
    expect(commands).toContain("npm run build");
    const bridgeStep = job.steps.find(
      (step: { name: string }) => step.name === "Test the host bridge owner release contract",
    );
    expect(bridgeStep).toMatchObject({
      env: {
        FLOW_TEST_HOST_BRIDGE_GUARDIAN:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert the literal GitHub runner path.
          "${{ runner.temp }}/flow-native-observer/flow-host-bridge-guardian",
      },
      run: "npm run test:runtime -- test/runtime/host-bridge-guardian.runtime.test.ts",
    });
    expect(source).not.toContain("FLOW_TEST_HOST_BRIDGE_BASELINE");
    expect(source).not.toContain("FLOW_TEST_HOST_BRIDGE_INTERRUPT_BASELINE");
    const descendantStep = job.steps.find(
      (step: { name: string }) => step.name === "Test active bridge descendants",
    );
    expect(descendantStep).toMatchObject({
      env: {
        FLOW_TEST_HOST_BRIDGE_GUARDIAN:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert the literal GitHub runner path.
          "${{ runner.temp }}/flow-native-observer/flow-host-bridge-guardian",
      },
      run: "npm run test:runtime -- test/runtime/host-bridge-descendants.runtime.test.ts",
    });
    expect(
      job.steps.find((step: { name: string }) => step.name === "Test bridge startup cleanup"),
    ).toMatchObject({
      env: {
        FLOW_TEST_HOST_BRIDGE_GUARDIAN:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert the literal GitHub runner path.
          "${{ runner.temp }}/flow-native-observer/flow-host-bridge-guardian",
      },
      run: "npm run test:runtime -- test/runtime/host-bridge-startup.runtime.test.ts",
    });
    expect(
      job.steps.find(
        (step: { name: string }) => step.name === "Calibrate bridge settlement predicate",
      ),
    ).toMatchObject({
      env: {
        FLOW_TEST_HOST_BRIDGE_GUARDIAN:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert the literal GitHub runner path.
          "${{ runner.temp }}/flow-native-observer/flow-host-bridge-guardian",
      },
      run: "npm run test:runtime -- test/runtime/host-bridge-predicate.runtime.test.ts",
    });
    expect(commands).toContain(
      'node native/verification-observer/build.mjs --build-observer-failure-controls "$RUNNER_TEMP/flow-native-observer"',
    );
    expect(job.steps.at(-1).env).toEqual({
      FLOW_TEST_NATIVE_OBSERVER_HELPER:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert the literal GitHub runner path expression.
        "${{ runner.temp }}/flow-native-observer/flow-observer-apply-seccomp",
      FLOW_TEST_NATIVE_OBSERVER_FALSE_NORMAL_HELPER:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert the literal separately identified test-only artifact path.
        "${{ runner.temp }}/flow-native-observer/test-controls/false-normal/flow-observer-apply-seccomp-false-normal",
    });
    expect(commands).toContain(
      "/usr/bin/python3 -I -S -c 'import subprocess, sys; sys.exit(subprocess.call(sys.argv[1:], close_fds=True))'",
    );
    expect(commands).toContain(
      "npm run test:runtime -- test/runtime/native-observer-transport.runtime.test.ts",
    );
    expect(commands).not.toMatch(/proof:prepare|gh\s|git push|npm publish|curl|wget/);
  });
});
