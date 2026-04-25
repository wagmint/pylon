import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";
import { openSync, readSync, closeSync, readdirSync, statSync } from "fs";

vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("fs", () => ({
  openSync: vi.fn(() => 42),
  readSync: vi.fn(() => 0),
  closeSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);
const mockedOpenSync = vi.mocked(openSync);
const mockedReadSync = vi.mocked(readSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedStatSync = vi.mocked(statSync);

/** Helper: mock readSync to fill the buffer with the given content. */
function mockTranscriptContent(content: string) {
  const bytes = Buffer.from(content, "utf-8");
  mockedOpenSync.mockReturnValue(42 as any);
  mockedReadSync.mockImplementation((_fd: any, buf: any) => {
    bytes.copy(buf);
    return Math.min(bytes.length, buf.length);
  });
}

// Re-import after mocks are set up — each test gets a fresh module to clear caches.
async function loadModule() {
  const mod = await import("./git-state.js");
  return mod;
}

describe("normalizeProjectPath", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("normalizes a path inside a repo to the repo root", async () => {
    mockedExecSync.mockImplementation((cmd: unknown, opts: any) => {
      if (String(cmd).includes("--show-toplevel") && opts?.cwd === "/hex/hexdeck/src") {
        return "/hex/hexdeck\n";
      }
      throw new Error("not a git repo");
    });

    const { normalizeProjectPath } = await loadModule();
    expect(normalizeProjectPath("/hex/hexdeck/src")).toBe("/hex/hexdeck");
  });

  it("returns the path unchanged when it IS the repo root", async () => {
    mockedExecSync.mockImplementation((cmd: unknown, opts: any) => {
      if (String(cmd).includes("--show-toplevel") && opts?.cwd === "/hex/hexdeck") {
        return "/hex/hexdeck\n";
      }
      throw new Error("not a git repo");
    });

    const { normalizeProjectPath } = await loadModule();
    expect(normalizeProjectPath("/hex/hexdeck")).toBe("/hex/hexdeck");
  });

  it("returns single child repo when parent has one git child", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    mockedReaddirSync.mockReturnValue([
      { name: "app", isDirectory: () => true, isFile: () => false } as any,
      { name: "docs", isDirectory: () => true, isFile: () => false } as any,
    ]);

    mockedStatSync.mockImplementation((p: any) => {
      if (String(p) === "/parent/app/.git") return {} as any;
      throw new Error("ENOENT");
    });

    const { normalizeProjectPath } = await loadModule();
    expect(normalizeProjectPath("/parent")).toBe("/parent/app");
  });

  it("resolves multi-repo parent using transcript peek when one child is mentioned", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    mockedReaddirSync.mockReturnValue([
      { name: "hexdeck", isDirectory: () => true, isFile: () => false } as any,
      { name: "hexcore", isDirectory: () => true, isFile: () => false } as any,
    ]);

    mockedStatSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s === "/hex/hexdeck/.git" || s === "/hex/hexcore/.git") return {} as any;
      throw new Error("ENOENT");
    });

    mockTranscriptContent('{"role":"assistant","content":"Working on hexdeck dashboard"}\n');

    const { normalizeProjectPath } = await loadModule();
    expect(normalizeProjectPath("/hex", "/path/to/transcript.jsonl")).toBe("/hex/hexdeck");
  });

  it("returns parent path unchanged when transcript mentions multiple children", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    mockedReaddirSync.mockReturnValue([
      { name: "hexdeck", isDirectory: () => true, isFile: () => false } as any,
      { name: "hexcore", isDirectory: () => true, isFile: () => false } as any,
    ]);

    mockedStatSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s === "/hex/hexdeck/.git" || s === "/hex/hexcore/.git") return {} as any;
      throw new Error("ENOENT");
    });

    mockTranscriptContent('{"content":"Changes in hexdeck and hexcore repos"}\n');

    const { normalizeProjectPath } = await loadModule();
    expect(normalizeProjectPath("/hex", "/path/to/transcript.jsonl")).toBe("/hex");
  });

  it("returns non-git directory unchanged", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    mockedReaddirSync.mockReturnValue([]);

    const { normalizeProjectPath } = await loadModule();
    expect(normalizeProjectPath("/tmp/random")).toBe("/tmp/random");
  });

  it("returns parent path unchanged when no transcript is provided for multi-repo", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    mockedReaddirSync.mockReturnValue([
      { name: "hexdeck", isDirectory: () => true, isFile: () => false } as any,
      { name: "hexcore", isDirectory: () => true, isFile: () => false } as any,
    ]);

    mockedStatSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s === "/hex/hexdeck/.git" || s === "/hex/hexcore/.git") return {} as any;
      throw new Error("ENOENT");
    });

    const { normalizeProjectPath } = await loadModule();
    expect(normalizeProjectPath("/hex")).toBe("/hex");
  });
});

describe("resolveGitRoot", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns repo root from git rev-parse", async () => {
    mockedExecSync.mockReturnValue("/repo/root\n");

    const { resolveGitRoot } = await loadModule();
    expect(resolveGitRoot("/repo/root/sub")).toBe("/repo/root");
  });

  it("returns null for non-git path", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const { resolveGitRoot } = await loadModule();
    expect(resolveGitRoot("/tmp")).toBeNull();
  });

  it("caches results", async () => {
    mockedExecSync.mockReturnValue("/repo\n");

    const { resolveGitRoot } = await loadModule();
    resolveGitRoot("/repo/a");
    resolveGitRoot("/repo/a");

    // execSync should only be called once for the same path
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });
});
