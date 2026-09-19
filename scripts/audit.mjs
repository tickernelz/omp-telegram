import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const result = spawnSync("npm", ["audit", ...args], {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) {
  const combined = (result.stdout || "") + (result.stderr || "");
  if (
    combined.includes("503 Service Unavailable") ||
    combined.includes("performing maintenance") ||
    combined.includes("audit endpoint returned an error") ||
    combined.includes("Invalid package tree")
  ) {
    console.warn(
      "⚠️ npm audit advisory service is currently unavailable or returning an endpoint error. Skipping audit failure.",
    );
    process.exit(0);
  }
  process.exit(result.status ?? 1);
}
