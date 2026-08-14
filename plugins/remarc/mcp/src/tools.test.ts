import { describe, expect, it } from "vitest";
import { formatCommentDetail, formatCommentLine } from "./tools.js";
import type { Comment, Session } from "./data.js";

const session: Session = {
  id: "S1",
  name: "Reference Review",
  createdAt: new Date(0),
  isDeleted: false,
  deletedAt: null,
  isAutoDismissed: false,
  autoDismissedAt: null,
  origin: "manual",
  claudeCodeSessionId: null,
  unknownFields: {},
};

function selectedComment(selectedText: string, commentText = ""): Comment {
  return {
    id: "BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    shortID: "bbbbb",
    type: { comment: { text: selectedText } },
    commentText,
    source: "Xcode",
    appBundleID: "com.apple.dt.Xcode",
    createdAt: new Date(0),
    updatedAt: new Date(1000),
    sessionID: session.id,
    isDeleted: false,
    deletedAt: null,
    status: "handedOff",
    resolutionSummary: null,
    resolvedBy: null,
    resolvedAt: null,
    attachments: [],
    webContext: null,
    regionElements: null,
    wakeRequestedAt: null,
    unknownFields: {},
  };
}

function screenshotComment(imagePath: string): Comment {
  return {
    ...selectedComment("", ""),
    type: { screenshot: { imagePath } },
    source: "Screenshot",
  };
}

describe("reference-only comment formatting", () => {
  it("keeps list references bounded and labels an absent body", () => {
    const selectedText = `first line\n${"x".repeat(100)} END-OF-SELECTION`;

    const rendered = formatCommentLine(selectedComment(selectedText), [session]);

    expect(rendered).toContain('"first line ');
    expect(rendered).toContain('..."');
    expect(rendered).not.toContain("END-OF-SELECTION");
    expect(rendered).toContain("Comment: (none)");
  });

  it("returns the complete selected text separately in full detail", () => {
    const selectedText = `first line\n${"x".repeat(100)} END-OF-SELECTION`;

    const rendered = formatCommentDetail(
      selectedComment(selectedText, "   "),
      [session]
    );

    expect(rendered).toContain(`Selected Text: ${selectedText}`);
    expect(rendered).toContain("Text: (none)");
  });

  it("keeps a present comment body unchanged", () => {
    const rendered = formatCommentDetail(
      selectedComment("selected", "Please revise this"),
      [session]
    );

    expect(rendered).toContain("Text: Please revise this");
  });

  it("resolves a blank screenshot's relative image path beside the data file", () => {
    const rendered = formatCommentDetail(
      screenshotComment("images/capture.png"),
      [session],
      "/Users/test/Library/Application Support/Remarc/comments.json"
    );

    expect(rendered).toContain("Text: (none)");
    expect(rendered).toContain(
      "Image Path: /Users/test/Library/Application Support/Remarc/images/capture.png"
    );
  });

  it("preserves a blank screenshot's legacy absolute image path", () => {
    const rendered = formatCommentDetail(
      screenshotComment("/tmp/legacy-capture.png"),
      [session],
      "/Users/test/Library/Application Support/Remarc/comments.json"
    );

    expect(rendered).toContain("Text: (none)");
    expect(rendered).toContain("Image Path: /tmp/legacy-capture.png");
  });
});
