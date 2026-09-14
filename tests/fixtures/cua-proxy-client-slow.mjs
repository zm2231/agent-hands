process.stdin.setEncoding("utf8");
let buf = "";
let expected = 0;
let ordered = true;

function drain() {
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    const n = Number.parseInt(line.split(":")[0], 10);
    if (n !== expected) ordered = false;
    expected++;
  }
}

process.stdin.on("data", (chunk) => {
  process.stdin.pause();
  buf += chunk;
  drain();
  setTimeout(() => process.stdin.resume(), 15);
});
process.stdin.on("end", () => {
  drain();
  process.stdout.write(`done ${expected} ${ordered}\n`);
  process.exit(0);
});
