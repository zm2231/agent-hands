import { spawn } from "node:child_process";
import { stripAuthChangeCapability } from "./cua-proxy-transform.js";

const [clientPath, ...clientArgs] = process.argv.slice(2);
if (!clientPath) {
  process.stderr.write("cua-proxy: missing client path\n");
  process.exit(2);
}

const child = spawn(clientPath, clientArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
  cwd: process.cwd(),
});

child.on("error", () => process.exit(1));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

function terminateChild(): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2000).unref();
}

let clientWritable = true;
child.stdin.on("error", () => {
  clientWritable = false;
  process.stdin.pause();
});

child.stdout.on("error", terminateChild);
process.stdout.on("error", terminateChild);
child.stdout.pipe(process.stdout);

let buf = "";

function pump(): void {
  if (!clientWritable) return;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!child.stdin.write(stripAuthChangeCapability(line) + "\n")) {
      process.stdin.pause();
      child.stdin.once("drain", () => {
        process.stdin.resume();
        pump();
      });
      return;
    }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  pump();
});
process.stdin.on("end", () => {
  if (!clientWritable) return;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    child.stdin.write(stripAuthChangeCapability(line) + "\n");
  }
  if (buf.length > 0) child.stdin.write(stripAuthChangeCapability(buf));
  buf = "";
  child.stdin.end();
});
