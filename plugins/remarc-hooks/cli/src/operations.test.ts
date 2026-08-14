import { describe, expect, it } from "vitest";
import { formatComments } from "./operations.js";
import type { AppState, Comment, Session } from "./data.js";

const session: Session = {
  id: "S1",
  name: "Reference Review",
  createdAt: new Date(0),
  isDeleted: false,
  deletedAt: null,
  isAutoDismissed: false,
  autoDismissedAt: null,
  origin: "claudeCode",
  claudeCodeSessionId: "agent-1",
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

function state(comment: Comment): AppState {
  return {
    sessions: [session],
    comments: [comment],
    activeSessionID: session.id,
    totalCommentsCreated: 1,
    unknownFields: {},
  };
}

describe("formatComments reference-only contract", () => {
  it("labels an absent body and preserves the complete selected text in sentinels", () => {
    const selectedText = `first line\n${"x".repeat(200)} END-OF-SELECTION`;
    const comment = selectedComment(selectedText, "   ");

    const rendered = formatComments([comment], state(comment), 9000);

    expect(rendered.includedIds).toEqual([comment.id]);
    expect(rendered.text).toContain("Type: comment");
    expect(rendered.text).toContain("Comment text: (none)");
    expect(rendered.text).toContain(
      `Full context: call remarc_get_comment with id "${comment.id}" before acting.`
    );
    const selected = rendered.text.match(
      /Selected text: <<<REMARC-DATA-([0-9a-f]{8})>>>\n([\s\S]*?)\n<<<END-\1>>>/
    );
    expect(selected?.[2]).toBe(selectedText);
  });

  it("keeps oversized reference-only context bounded, balanced, and retrievable", () => {
    const selectedText = `${"x".repeat(50_000)} END-OF-SELECTION`;
    const comment = selectedComment(selectedText, "");

    const rendered = formatComments([comment], state(comment), 9000);

    expect(rendered.includedIds).toEqual([comment.id]);
    expect(rendered.text.length).toBeLessThanOrEqual(9000);
    const fetchInstruction =
      `Full context: call remarc_get_comment with id "${comment.id}" before acting.`;
    expect(rendered.text).toContain(fetchInstruction);
    expect(rendered.text).toContain("[… truncated; fetch full context …]");
    expect(rendered.text).not.toContain("END-OF-SELECTION");

    const selected = rendered.text.match(
      /Selected text: <<<REMARC-DATA-([0-9a-f]{8})>>>\n([\s\S]*?)\n<<<END-\1>>>/
    );
    expect(selected).not.toBeNull();
    expect(rendered.text.indexOf(fetchInstruction)).toBeGreaterThan(
      (selected?.index ?? 0) + (selected?.[0].length ?? 0)
    );

    const openTokens = [
      ...rendered.text.matchAll(/<<<REMARC-DATA-([0-9a-f]{8})>>>/g),
    ].map((match) => match[1]);
    expect(openTokens.length).toBeGreaterThan(0);
    for (const token of openTokens) {
      expect(rendered.text.match(new RegExp(`<<<END-${token}>>>`, "g"))).toHaveLength(1);
    }
  });

  it("identifies a blank screenshot and directs the agent to its full context", () => {
    const comment: Comment = {
      ...selectedComment(""),
      type: { screenshot: { imagePath: "images/capture.png" } },
      source: "Screenshot",
    };

    const rendered = formatComments([comment], state(comment), 9000);

    expect(rendered.text).toContain("Type: screenshot");
    expect(rendered.text).toContain("Comment text: (none)");
    expect(rendered.text).toContain(
      `Full context: call remarc_get_comment with id "${comment.id}" before acting.`
    );
  });

  it("identifies a blank web element and fetches context without injecting page data", () => {
    const pageUrl = "https://private.example/review";
    const elementName = "SECRET PAGE ELEMENT";
    const comment: Comment = {
      ...selectedComment(""),
      type: { webElement: { componentName: "SaveButton", filePath: "Editor.tsx" } },
      source: "Web Element",
      webContext: { pageUrl, elementName },
    };

    const rendered = formatComments([comment], state(comment), 9000);

    expect(rendered.text).toContain("Type: webElement");
    expect(rendered.text).toContain("Comment text: (none)");
    expect(rendered.text).toContain(
      `Full context: call remarc_get_comment with id "${comment.id}" before acting.`
    );
    expect(rendered.text).not.toContain(pageUrl);
    expect(rendered.text).not.toContain(elementName);
  });

  it("labels and sentinel-wraps a present body", () => {
    const comment = selectedComment("selected", "Please revise this");

    const rendered = formatComments([comment], state(comment), 9000);

    expect(rendered.text).toContain("Type: comment");
    expect(rendered.text).not.toContain("Full context: call remarc_get_comment");
    const body = rendered.text.match(
      /Comment text: <<<REMARC-DATA-([0-9a-f]{8})>>>\n([\s\S]*?)\n<<<END-\1>>>/
    );
    expect(body?.[2]).toBe("Please revise this");
  });
});
