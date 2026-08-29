import { describe, expect, it } from "vitest";

import { serializeBoundedIssueReviewContext } from "../../../src/application/issue-independent-review-projection.js";
import {
  MAX_ISSUE_REVIEW_CONTEXT_BYTES,
  MAX_ISSUE_WORKFLOW_CONTEXT_BYTES,
} from "../../../src/application/issue-workflow-admission.js";

describe("independent review projection", () => {
  it("accepts the exact UTF-8 boundary and rejects one additional byte", () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ content: "" }), "utf8");
    const exact = { content: "x".repeat(MAX_ISSUE_REVIEW_CONTEXT_BYTES - emptyBytes) };
    const oversized = { content: `${exact.content}x` };

    expect(Buffer.byteLength(serializeBoundedIssueReviewContext(exact), "utf8")).toBe(
      MAX_ISSUE_REVIEW_CONTEXT_BYTES,
    );
    expect(() => serializeBoundedIssueReviewContext(oversized)).toThrow(
      /review projection.*262144.*UTF-8 bytes/i,
    );
  });

  it("keeps the ordinary issue context boundary narrower than the review projection", () => {
    expect(MAX_ISSUE_REVIEW_CONTEXT_BYTES).toBe(262_144);
    expect(MAX_ISSUE_WORKFLOW_CONTEXT_BYTES).toBe(65_536);
    expect(MAX_ISSUE_REVIEW_CONTEXT_BYTES).toBeGreaterThan(MAX_ISSUE_WORKFLOW_CONTEXT_BYTES);
  });

  it("counts JSON escaping and multibyte characters after exact serialization", () => {
    const escaped = serializeBoundedIssueReviewContext({ content: 'line\nquoted "value"' });
    const multibyte = serializeBoundedIssueReviewContext({ content: "€" });

    expect(Buffer.byteLength(escaped, "utf8")).toBe(
      Buffer.byteLength(
        JSON.stringify({
          content: 'line\nquoted "value"',
        }),
        "utf8",
      ),
    );
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(multibyte.length);
  });
});
