import { readdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

const outputDirectory = join(process.cwd(), ".tmp", "playwright-results");
const leftovers = await readdir(outputDirectory, { recursive: true }).catch(() => []);
const failureArtifacts = leftovers.filter((path) => path !== ".last-run.json");
if (failureArtifacts.length)
  throw new Error(`Browser verification left failure artifacts: ${failureArtifacts.join(", ")}`);
await rm(outputDirectory, { recursive: true, force: true });

await new Promise<void>((resolve, reject) => {
  const socket = connect({ host: "127.0.0.1", port: 4178 });
  socket.once("connect", () => {
    socket.destroy();
    reject(new Error("Browser verification left a Norvyn test server running on port 4178."));
  });
  socket.once("error", () => resolve());
});
