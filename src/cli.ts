import { spawn } from "node:child_process";
import { startNorvyn } from "./server.js";

const noOpen = process.argv.includes("--no-open");
const norvyn = await startNorvyn(process.cwd());

process.stdout.write(`${norvyn.url}\n`);
if (!noOpen) openBrowser(norvyn.url);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await norvyn.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function openBrowser(url: string) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const browser = spawn(command, args, { detached: true, stdio: "ignore" });
  browser.unref();
}
