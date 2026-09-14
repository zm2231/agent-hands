process.stdout.write(`pid:${process.pid}\n`);
const tick = setInterval(() => {
  try {
    process.stdout.write("tick\n");
  } catch {}
}, 40);
process.on("SIGTERM", () => {
  clearInterval(tick);
  process.exit(0);
});
setTimeout(() => process.exit(0), 6000);
