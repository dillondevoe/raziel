import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/tools/workspace";
import { scrubEnv, runCommandTool } from "../src/tools/exec";
import { classifyUrl, fetchTool } from "../src/tools/fetch";

function mkws(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "raziel-exec-ws-"));
  return new Workspace(dir);
}

describe("scrubEnv", () => {
  test("drops secret-shaped names, keeps ordinary ones", () => {
    const scrubbed = scrubEnv({
      ANTHROPIC_API_KEY: "secret1",
      RAZIEL_COMPAT_KEY: "secret2",
      MY_APP_TOKEN: "secret3",
      AWS_ANYTHING: "secret4",
      GH_TOKEN: "secret5",
      GITHUB_TOKEN: "secret6",
      OPENAI_API_KEY: "secret7",
      NPM_TOKEN: "secret8",
      SOME_SECRET: "secret9",
      SOME_PASSWORD: "secret10",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      HOME: "/home/x",
    });
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.RAZIEL_COMPAT_KEY).toBeUndefined();
    expect(scrubbed.MY_APP_TOKEN).toBeUndefined();
    expect(scrubbed.AWS_ANYTHING).toBeUndefined();
    expect(scrubbed.GH_TOKEN).toBeUndefined();
    expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.NPM_TOKEN).toBeUndefined();
    expect(scrubbed.SOME_SECRET).toBeUndefined();
    expect(scrubbed.SOME_PASSWORD).toBeUndefined();
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.LANG).toBe("en_US.UTF-8");
    expect(scrubbed.HOME).toBe("/home/x");
  });

  test("drops undefined values entirely", () => {
    const scrubbed = scrubEnv({ FOO: undefined, PATH: "/bin" });
    expect(scrubbed.FOO).toBeUndefined();
    expect(scrubbed.PATH).toBe("/bin");
  });
});

describe("runCommandTool", () => {
  test("runs argv and captures stdout with exit code prefix", async () => {
    const ws = mkws();
    const res = await runCommandTool.run({ argv: ["/bin/echo", "hi"] }, ws);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("exit 0");
    expect(res.output).toContain("hi");
  });

  test("scrubs secrets from the child environment", async () => {
    const ws = mkws();
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-secret";
    try {
      const res = await runCommandTool.run({ argv: ["/usr/bin/env"] }, ws);
      expect(res.output).not.toContain("test-secret");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("rejects a string instead of an argv array", async () => {
    const ws = mkws();
    const res = await runCommandTool.run({ argv: "/bin/echo hi" }, ws);
    expect(res.ok).toBe(false);
  });

  test("rejects missing argv", async () => {
    const ws = mkws();
    const res = await runCommandTool.run({}, ws);
    expect(res.ok).toBe(false);
  });

  test("nonexistent binary returns ok:false, does not throw", async () => {
    const ws = mkws();
    const res = await runCommandTool.run({ argv: ["/no/such/binary-xyz"] }, ws);
    expect(res.ok).toBe(false);
  });

  test("cwd is contained within the workspace", async () => {
    const ws = mkws();
    const res = await runCommandTool.run({ argv: ["/bin/pwd"], cwd: "../../etc" }, ws);
    expect(res.ok).toBe(false);
  });
});

describe("classifyUrl", () => {
  test("localhost is private", () => {
    expect(classifyUrl("http://localhost:8080/x")).toBe("private");
  });
  test("127.0.0.1 is private", () => {
    expect(classifyUrl("http://127.0.0.1/")).toBe("private");
  });
  test("192.168.x.x is private", () => {
    expect(classifyUrl("http://192.168.1.5/")).toBe("private");
  });
  test("10.x.x.x is private", () => {
    expect(classifyUrl("http://10.0.0.1/")).toBe("private");
  });
  test("172.16-31.x.x is private (172.20 explicit octet-parse case)", () => {
    expect(classifyUrl("http://172.20.0.5/")).toBe("private");
    expect(classifyUrl("http://172.16.0.1/")).toBe("private");
    expect(classifyUrl("http://172.31.255.255/")).toBe("private");
  });
  test("172.15 and 172.32 are public (just outside the /12 range)", () => {
    expect(classifyUrl("http://172.15.0.1/")).toBe("public");
    expect(classifyUrl("http://172.32.0.1/")).toBe("public");
  });
  test("169.254.x.x link-local is private", () => {
    expect(classifyUrl("http://169.254.1.1/")).toBe("private");
  });
  test("0.0.0.0 is private", () => {
    expect(classifyUrl("http://0.0.0.0/")).toBe("private");
  });
  test("::1 is private", () => {
    expect(classifyUrl("http://[::1]/")).toBe("private");
  });
  test("named public host is public", () => {
    expect(classifyUrl("https://example.com/")).toBe("public");
  });
  test("non-http(s) scheme is invalid", () => {
    expect(classifyUrl("ftp://x/")).toBe("invalid");
  });
  test("garbage string is invalid", () => {
    expect(classifyUrl("not a url")).toBe("invalid");
  });
});

describe("fetchTool", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterAll(() => {
    server?.stop(true);
  });

  test("200 text response is ok:true and tainted", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response("hello world", { status: 200 });
      },
    });
    const ws = mkws();
    const res = await fetchTool.run({ url: `http://localhost:${server.port}/` }, ws);
    expect(res.ok).toBe(true);
    expect(res.output.startsWith("[UNTRUSTED FETCHED CONTENT]\n")).toBe(true);
    expect(res.output).toContain("hello world");
  });

  test("cross-origin redirect is rejected", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1:1/" },
        });
      },
    });
    const ws = mkws();
    const res = await fetchTool.run({ url: `http://localhost:${server.port}/` }, ws);
    expect(res.ok).toBe(false);
    expect(res.output.toLowerCase()).toContain("redirect");
  });

  test("same-origin redirect is followed", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/start") {
          return new Response(null, {
            status: 302,
            headers: { Location: `http://localhost:${server!.port}/end` },
          });
        }
        return new Response("landed", { status: 200 });
      },
    });
    const ws = mkws();
    const res = await fetchTool.run({ url: `http://localhost:${server.port}/start` }, ws);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("landed");
  });

  test("non-http(s) url is rejected", async () => {
    const ws = mkws();
    const res = await fetchTool.run({ url: "ftp://example.com/" }, ws);
    expect(res.ok).toBe(false);
  });

  test("missing url arg returns ok:false", async () => {
    const ws = mkws();
    const res = await fetchTool.run({}, ws);
    expect(res.ok).toBe(false);
  });
});
