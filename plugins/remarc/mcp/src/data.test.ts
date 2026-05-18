import { describe, it, expect } from "vitest";
import {
  parseAppState,
  serializeAppState,
  formatWebContextSection,
  webContextPreview,
  typeIdentifier,
  typeLabel,
  type RawAppState,
  type WebContext,
} from "./data.js";

// New-shape (post-Agentation-alignment) WebContext: flat strings throughout.
const FLAT_WEB_CONTEXT: WebContext = {
  componentName: "LoginForm",
  filePath: "src/components/LoginForm.tsx",
  elementName: "button.primary-cta",
  elementPath: "form > button.primary-cta",
  selectedText: "Sign in",
  cssClasses: "primary-cta btn-large",
  selector: "#root form button.primary-cta",
  computedStyles: "color: rgb(255, 255, 255); backgroundColor: rgb(59, 130, 246)",
  accessibility: 'role=button, aria-label="Sign in", tabIndex=0, focusable=true',
  nearbyText: 'before: "Forgot your password?"; after: "Or continue with Google"',
  nearbyElements: '<input.email-field#email>',
  boundingBox: { x: 120, y: 340, width: 480, height: 40 },
  pageUrl: "https://example.com/login",
};

// Legacy on-disk shape with structured nested objects. Used to verify back-compat.
const LEGACY_WEB_CONTEXT = {
  componentName: "LoginForm",
  filePath: "src/components/LoginForm.tsx",
  hierarchy: "App > Router > LoginForm > Button",
  elementName: "button.primary-cta",
  elementPath: "form > button.primary-cta",
  fullPath: "#root > div.app > main > form > button.primary-cta",
  selectedText: "Sign in",
  cssClasses: "primary-cta btn-large",
  selector: "#root form button.primary-cta",
  computedStyles: {
    color: "rgb(255, 255, 255)",
    backgroundColor: "rgb(59, 130, 246)",
  },
  accessibility: {
    role: "button",
    ariaLabel: "Sign in",
    tabIndex: 0,
    focusable: true,
  },
  nearbyText: {
    element: "Sign in",
    before: "Forgot your password?",
    after: "Or continue with Google",
  },
  nearbyElements: [
    { tag: "input", classes: "email-field", id: "email", textSnippet: null },
  ],
  parent: { tag: "form", childCount: 3 },
  boundingBox: { x: 120, y: 340, width: 480, height: 40 },
  pageUrl: "https://example.com/login",
} as unknown as WebContext;

function makeRawState(extraFields: Partial<RawAppState> = {}): RawAppState {
  return {
    sessions: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        name: "Test Session",
        createdAt: 0,
        isDeleted: false,
        isAutoDismissed: false,
      },
    ],
    comments: [],
    activeSessionID: "11111111-1111-1111-1111-111111111111",
    totalCommentsCreated: 0,
    ...extraFields,
  };
}

describe("WebContext round-trip preservation", () => {
  it("preserves flat-shape webContext through parse → serialize", () => {
    const raw: RawAppState = makeRawState({
      comments: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          type: { quickNote: {} },
          commentText: "test",
          source: "Web Element",
          createdAt: 0,
          updatedAt: 0,
          sessionID: "11111111-1111-1111-1111-111111111111",
          isDeleted: false,
          status: "open",
          webContext: FLAT_WEB_CONTEXT,
        },
      ],
      totalCommentsCreated: 1,
    });

    const parsed = parseAppState(raw);
    const serialized = serializeAppState(parsed) as RawAppState;

    expect(serialized.comments[0].webContext).toEqual(FLAT_WEB_CONTEXT);
  });

  it("preserves legacy structured webContext byte-identical (no flattening on round-trip)", () => {
    const raw: RawAppState = makeRawState({
      comments: [
        {
          id: "22222222-2222-2222-2222-222222222223",
          type: { quickNote: {} },
          commentText: "legacy",
          source: "Web Element",
          createdAt: 0,
          updatedAt: 0,
          sessionID: "11111111-1111-1111-1111-111111111111",
          isDeleted: false,
          status: "open",
          webContext: LEGACY_WEB_CONTEXT,
        },
      ],
      totalCommentsCreated: 1,
    });

    const parsed = parseAppState(raw);
    const serialized = serializeAppState(parsed) as RawAppState;

    // The TS round-trip is byte-for-byte: it doesn't transform legacy → flat.
    // The Swift side does that on its next save when it re-encodes the comment.
    expect(serialized.comments[0].webContext).toEqual(LEGACY_WEB_CONTEXT);
  });

  it("preserves regionElements through round-trip", () => {
    const raw: RawAppState = makeRawState({
      comments: [
        {
          id: "33333333-3333-3333-3333-333333333333",
          type: { critMode: {} },
          commentText: "region",
          source: "Web Element",
          createdAt: 0,
          updatedAt: 0,
          sessionID: "11111111-1111-1111-1111-111111111111",
          isDeleted: false,
          status: "open",
          regionElements: [FLAT_WEB_CONTEXT, { ...FLAT_WEB_CONTEXT, elementName: "input.email" }],
        },
      ],
      totalCommentsCreated: 1,
    });

    const parsed = parseAppState(raw);
    const serialized = serializeAppState(parsed) as RawAppState;

    expect(serialized.comments[0].regionElements).toHaveLength(2);
    expect(serialized.comments[0].regionElements?.[1].elementName).toBe(
      "input.email"
    );
  });

  it("preserves unknown forward-compat fields through round-trip", () => {
    const futureField = { someFutureField: { nested: 42 } };
    const wc: WebContext = { ...FLAT_WEB_CONTEXT, ...futureField };
    const raw: RawAppState = makeRawState({
      comments: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          type: { quickNote: {} },
          commentText: "x",
          source: "Web Element",
          createdAt: 0,
          updatedAt: 0,
          sessionID: "11111111-1111-1111-1111-111111111111",
          isDeleted: false,
          status: "open",
          webContext: wc,
        },
      ],
      totalCommentsCreated: 1,
    });

    const parsed = parseAppState(raw);
    const serialized = serializeAppState(parsed) as RawAppState;

    expect(
      (serialized.comments[0].webContext as Record<string, unknown>).someFutureField
    ).toEqual({ nested: 42 });
  });

  it("preserves elementHTML on disk when present (back-compat with very-legacy data)", () => {
    const wc = { ...FLAT_WEB_CONTEXT, elementHTML: "<button>Click</button>" } as WebContext;
    const raw: RawAppState = makeRawState({
      comments: [
        {
          id: "55555555-5555-5555-5555-555555555555",
          type: { quickNote: {} },
          commentText: "legacy",
          source: "Web Element",
          createdAt: 0,
          updatedAt: 0,
          sessionID: "11111111-1111-1111-1111-111111111111",
          isDeleted: false,
          status: "open",
          webContext: wc,
        },
      ],
      totalCommentsCreated: 1,
    });

    const parsed = parseAppState(raw);
    const serialized = serializeAppState(parsed) as RawAppState;

    expect(
      (serialized.comments[0].webContext as Record<string, unknown>).elementHTML
    ).toBe("<button>Click</button>");
  });

  it("handles comments with no webContext", () => {
    const raw: RawAppState = makeRawState({
      comments: [
        {
          id: "66666666-6666-6666-6666-666666666666",
          type: { quickNote: {} },
          commentText: "no context",
          source: "Mac App",
          createdAt: 0,
          updatedAt: 0,
          sessionID: "11111111-1111-1111-1111-111111111111",
          isDeleted: false,
          status: "open",
        },
      ],
      totalCommentsCreated: 1,
    });

    const parsed = parseAppState(raw);
    expect(parsed.comments[0].webContext).toBeNull();
    expect(parsed.comments[0].regionElements).toBeNull();

    const serialized = serializeAppState(parsed) as RawAppState;
    expect(serialized.comments[0].webContext).toBeUndefined();
    expect(serialized.comments[0].regionElements).toBeUndefined();
  });
});

describe("formatWebContextSection — new flat shape", () => {
  it("emits sections directly from pre-flattened strings", () => {
    const lines = formatWebContextSection(FLAT_WEB_CONTEXT);
    const out = lines.join("\n");

    expect(out).toContain("Web Context:");
    expect(out).toContain("Page URL: https://example.com/login");
    expect(out).toContain("Component: LoginForm (src/components/LoginForm.tsx)");
    expect(out).toContain("Selector: #root form button.primary-cta");
    expect(out).toContain("Selected Text: Sign in");
    expect(out).toContain("Bounding Box: 480x40 at (120, 340)");
    expect(out).toContain("Computed Styles: color: rgb(255, 255, 255)");
    expect(out).toContain('Accessibility: role=button, aria-label="Sign in"');
    expect(out).toContain('Nearby Text: before: "Forgot your password?"');
    expect(out).toContain("Nearby Elements: <input.email-field#email>");
  });

  it("does NOT emit dropped fields (hierarchy, fullPath, parent)", () => {
    const wc = { ...LEGACY_WEB_CONTEXT };
    const lines = formatWebContextSection(wc);
    const out = lines.join("\n");
    expect(out).not.toContain("Hierarchy:");
    expect(out).not.toContain("Full Path:");
    expect(out).not.toContain("Parent:");
  });
});

describe("formatWebContextSection — legacy structured shape back-compat", () => {
  it("flattens legacy structured accessibility/nearbyText/nearbyElements/computedStyles", () => {
    const lines = formatWebContextSection(LEGACY_WEB_CONTEXT);
    const out = lines.join("\n");

    expect(out).toContain("Computed Styles: color: rgb(255, 255, 255); backgroundColor: rgb(59, 130, 246)");
    expect(out).toContain('Accessibility: role=button, aria-label="Sign in", tabIndex=0, focusable=true');
    expect(out).toContain('Nearby Text: before: "Forgot your password?"; after: "Or continue with Google"');
    expect(out).toContain("Nearby Elements: <input#email.email-field>");
  });

  it("does NOT expose elementHTML even when present on disk", () => {
    const wc = { ...FLAT_WEB_CONTEXT, elementHTML: "<button>SECRET HTML</button>" } as WebContext;
    const lines = formatWebContextSection(wc);
    const out = lines.join("\n");
    expect(out).not.toContain("SECRET HTML");
    expect(out).not.toContain("Element HTML");
  });

  it("returns empty array for null/undefined input", () => {
    expect(formatWebContextSection(null)).toEqual([]);
    expect(formatWebContextSection(undefined)).toEqual([]);
  });
});

describe("webContextPreview", () => {
  it("prefers elementName + filePath (DOM-first like Agentation)", () => {
    expect(webContextPreview(FLAT_WEB_CONTEXT)).toBe(
      "button.primary-cta · src/components/LoginForm.tsx"
    );
  });

  it("falls back to elementName + pageUrl when component info missing", () => {
    const wc: WebContext = {
      elementName: "button.cta",
      pageUrl: "https://example.com",
    };
    expect(webContextPreview(wc)).toBe("button.cta · https://example.com");
  });

  it("falls back to selector when neither component nor element name is set", () => {
    const wc: WebContext = { selector: "#login-button" };
    expect(webContextPreview(wc)).toBe("#login-button");
  });

  it("returns null for empty/null context", () => {
    expect(webContextPreview(null)).toBeNull();
    expect(webContextPreview({})).toBeNull();
  });
});

describe("CommentType helpers", () => {
  it("identifies webElement type", () => {
    const t = { webElement: { componentName: "Button", filePath: "src/Btn.tsx" } };
    expect(typeIdentifier(t)).toBe("webElement");
    expect(typeLabel(t)).toBe("Button · src/Btn.tsx");
  });

  it("falls back to 'Web Element' label when componentName/filePath are missing", () => {
    const t = { webElement: { componentName: null, filePath: null } };
    expect(typeLabel(t)).toBe("Web Element");
  });
});

describe("smart identification (Agentation DOM-first)", () => {
  it("prefers elementName over componentName when both are present", () => {
    const t = { webElement: { componentName: "TriggerButton", filePath: null } };
    const wc: WebContext = { elementName: 'p "Events"' };
    expect(typeLabel(t, wc)).toBe('p "Events"');
  });

  it("prefers descriptive elementName over generic componentName like 'View'", () => {
    const t = { webElement: { componentName: "View", filePath: null } };
    const wc: WebContext = { elementName: 'link "Priority"' };
    expect(typeLabel(t, wc)).toBe('link "Priority"');
  });

  it("falls back to componentName when elementName is missing", () => {
    const t = { webElement: { componentName: "LoginForm", filePath: "src/Login.tsx" } };
    const wc: WebContext = { elementName: null };
    expect(typeLabel(t, wc)).toBe("LoginForm · src/Login.tsx");
  });

  it("rejects minified componentName even as fallback when elementName is missing", () => {
    const t = { webElement: { componentName: "xC", filePath: null } };
    expect(typeLabel(t, {})).toBe("Web Element");
  });

  it("rejects 2-char names as minified", () => {
    const t = { webElement: { componentName: "UI", filePath: null } };
    const wc: WebContext = { elementName: 'button "Save"' };
    expect(typeLabel(t, wc)).toBe('button "Save"');
  });

  it("returns 'Web Element' when both componentName and elementName are missing", () => {
    const t = { webElement: { componentName: null, filePath: null } };
    expect(typeLabel(t, null)).toBe("Web Element");
    expect(typeLabel(t, {})).toBe("Web Element");
  });

  it("webContextPreview applies the same DOM-first priority", () => {
    const wc: WebContext = {
      componentName: "TriggerButton",
      elementName: 'p "Events"',
      pageUrl: "https://example.com",
    };
    expect(webContextPreview(wc)).toBe('p "Events" · https://example.com');
  });
});

describe("reactComponents chain field", () => {
  it("round-trips through parse → serialize", () => {
    const wc: WebContext = {
      ...FLAT_WEB_CONTEXT,
      reactComponents: "<LoginForm> <FormCard> <App>",
    };
    const raw: RawAppState = makeRawState({
      comments: [
        {
          id: "77777777-7777-7777-7777-777777777777",
          type: { webElement: { componentName: "LoginForm", filePath: "src/Login.tsx" } },
          commentText: "test",
          source: "Web Element",
          createdAt: 0,
          updatedAt: 0,
          sessionID: "11111111-1111-1111-1111-111111111111",
          isDeleted: false,
          status: "open",
          webContext: wc,
        },
      ],
      totalCommentsCreated: 1,
    });
    const parsed = parseAppState(raw);
    const serialized = serializeAppState(parsed) as RawAppState;
    expect(serialized.comments[0].webContext?.reactComponents).toBe(
      "<LoginForm> <FormCard> <App>"
    );
  });

  it("emits Via line in formatWebContextSection when present", () => {
    const wc: WebContext = {
      ...FLAT_WEB_CONTEXT,
      reactComponents: "<LoginForm> <FormCard> <App>",
    };
    const lines = formatWebContextSection(wc);
    const out = lines.join("\n");
    expect(out).toContain("Via: <LoginForm> <FormCard> <App>");
  });

  it("omits Via line when reactComponents is null/empty", () => {
    const wc: WebContext = { ...FLAT_WEB_CONTEXT, reactComponents: null };
    const lines = formatWebContextSection(wc);
    expect(lines.join("\n")).not.toContain("Via:");
  });
});
