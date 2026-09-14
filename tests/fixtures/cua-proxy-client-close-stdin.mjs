process.stdin.destroy();
setTimeout(() => process.exit(0), 400);
process.stdout.write("ready\n");
