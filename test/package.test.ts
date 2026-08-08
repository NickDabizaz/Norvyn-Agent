import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";

const paths: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("the packed artifact installs a global Windows command and runs without repository source imports", async () => {
  const staging = await temporaryDirectory("norvyn-pack-");
  const prefix = await temporaryDirectory("norvyn-global-");
  const workspace = await temporaryDirectory("norvyn-packed-workspace-");
  const packed = JSON.parse(
    await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", staging]),
  )[0];
  const files = packed.files.map((file: { path: string }) => file.path);
  expect(files).toContain("dist/cli.js");
  expect(files.some((file: string) => file.startsWith("dist/public/assets/"))).toBe(true);
  expect(files.some((file: string) => /^(src|test|schemas)\//.test(file))).toBe(false);

  const tarball = join(staging, packed.filename);
  await runNpm([
    "install",
    "--global",
    "--prefix",
    prefix,
    tarball,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
  ]);
  const command = process.platform === "win32" ? join(prefix, "norvyn.cmd") : join(prefix, "bin", "norvyn");
  await access(command);

  const installedCli = join(prefix, "node_modules", "norvyn", "dist", "cli.js");
  const root = process.cwd();
  const child = spawn(process.execPath, [installedCli, "--no-open"], {
    cwd: workspace,
    env: {
      ...process.env,
      NORVYN_SKIP_PREFLIGHT: "1",
      NORVYN_SKIP_UPDATE_CHECK: "1",
      NORVYN_PROVIDER_COMMAND: process.execPath,
      NORVYN_PROVIDER_ARGUMENTS: JSON.stringify([join(root, "test", "fixtures", "fake-provider.mjs")]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const url = await firstLine(child.stdout!);
  const connection = await connect(url);
  expect(connection).toMatchObject({ type: "connection", status: "connected", workspace });
  expect((await readFile(installedCli, "utf8")).startsWith("#!/usr/bin/env node")).toBe(true);
}, 120_000);

async function runNpm(args: string[]): Promise<string> {
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const child = spawn(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`npm ${args[0]} failed: ${stderr}`);
  return stdout;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  paths.push(path);
  return path;
}

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Packed Norvyn did not print a URL.")), 5_000);
    stream.on("data", (chunk) => {
      output += chunk;
      const end = output.indexOf("\n");
      if (end >= 0) {
        clearTimeout(timer);
        resolve(output.slice(0, end).trim());
      }
    });
    stream.once("error", reject);
  });
}

async function connect(httpUrl: string): Promise<unknown> {
  const accessToken = new URLSearchParams(new URL(httpUrl).hash.slice(1)).get("access");
  const response = await fetch(`${new URL(httpUrl).origin}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(httpUrl).origin },
    body: JSON.stringify({ access: accessToken }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Packed Norvyn did not create a Browser Session.");
  const socketUrl = new URL(httpUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/socket";
  socketUrl.hash = "";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl, { origin: new URL(httpUrl).origin, headers: { cookie } });
    socket.once("message", (message) => {
      resolve(JSON.parse(message.toString()));
      socket.close();
    });
    socket.once("error", reject);
  });
}
