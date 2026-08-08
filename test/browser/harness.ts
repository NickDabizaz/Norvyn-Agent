import { join } from "node:path";

process.env.NORVYN_PROVIDER_COMMAND = process.execPath;
process.env.NORVYN_PROVIDER_ARGUMENTS = JSON.stringify([
  join(process.cwd(), "test", "fixtures", "fake-provider.mjs"),
]);
process.env.NORVYN_FAKE_HISTORY_COUNT = "60";
process.env.NORVYN_FAKE_LONG_CHAT = "1";
process.env.NORVYN_SKIP_UPDATE_CHECK = "1";

const [{ startNorvyn }, { CodexAdapter }] = await Promise.all([
  import("../../src/server.js"),
  import("../../src/transport.js"),
]);

let pickerCalls = 0;
const server = await startNorvyn(process.cwd(), {
  port: 4178,
  sessionToken: () => "browser-test-access",
  preflight: async () => ({ ok: true, kind: "ready", providerPath: "fake-codex", version: "0.146.1" }),
  connectProvider: () => CodexAdapter.connect(),
  workspacePicker: {
    available: true,
    select: async () =>
      pickerCalls++ === 0
        ? { status: "cancelled" as const }
        : { status: "selected" as const, workspace: process.cwd() },
  },
});

process.stdout.write(`Browser harness ready at ${server.url}\n`);

let closing = false;
async function closeHarness(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
}

process.once("SIGINT", () => void closeHarness());
process.once("SIGTERM", () => void closeHarness());
