import { describe, expect, it } from "vitest";

import {
  canonicalGitHubRepositoryIdentity,
  parseGitHubIssueUrl,
} from "../../../src/domain/issue-lifecycle/identity.js";

describe("GitHub issue identity", () => {
  it("parses a canonical github.com issue URL", () => {
    expect(parseGitHubIssueUrl("https://github.com/SynaptiAI/Flow-Harness/issues/197/")).toEqual({
      host: "github.com",
      owner: "synaptiai",
      repository: "flow-harness",
      repositoryIdentity: "synaptiai/flow-harness",
      number: 197,
      canonicalUrl: "https://github.com/synaptiai/flow-harness/issues/197",
    });
  });

  it("canonicalizes an expected owner and repository identity", () => {
    expect(canonicalGitHubRepositoryIdentity("SynaptiAI/Flow-Harness")).toBe(
      "synaptiai/flow-harness",
    );
  });

  it("admits a canonical leading-dot GitHub repository name", () => {
    expect(canonicalGitHubRepositoryIdentity("Example/.GitHub")).toBe("example/.github");
    expect(parseGitHubIssueUrl("https://github.com/Example/.GitHub/issues/1")).toMatchObject({
      repositoryIdentity: "example/.github",
      canonicalUrl: "https://github.com/example/.github/issues/1",
    });
  });

  it.each([
    "owner/",
    "owner/.",
    "owner/..",
    "owner/.github.git",
    "owner/.git/other",
    "owner/.github%2Fother",
    "owner/.github!",
    `owner/.${"x".repeat(100)}`,
  ])("rejects invalid leading-dot repository identity %s", (identity) => {
    expect(() => canonicalGitHubRepositoryIdentity(identity)).toThrow(/repository identity/i);
  });

  it.each([
    "http://github.com/owner/repo/issues/1",
    "https://www.github.com/owner/repo/issues/1",
    "https://github.com/owner/repo/pull/1",
    "https://github.com/owner/repo/issues/0",
    "https://github.com/owner/repo/issues/01",
    "https://github.com/owner/repo/issues/1?tab=activity",
    "https://user@github.com/owner/repo/issues/1",
    "https://github.com:443/owner/repo/issues/1",
    "https://github.com/owner%2Frepo/project/issues/1",
  ])("rejects unsupported or ambiguous issue URL %s", (url) => {
    expect(() => parseGitHubIssueUrl(url)).toThrow(/GitHub issue URL/i);
  });
});
