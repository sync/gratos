// Imports the package's core entry alone, under plain Node, and prints what createServer is: the
// trace shows what the entry loads by itself, without the jit or Effect entries.
import { createServer } from "gratos-server";

process.stdout.write(typeof createServer);
