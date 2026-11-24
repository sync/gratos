import { packageName as gratosPackage } from "@dblechoc/gratos";
import { createServer } from "@dblechoc/gratos-server";

/** The workspace packages this example is built on. M6 replaces this module with the orders app. */
export const dependsOn: ReadonlyArray<string> = [gratosPackage, "@dblechoc/gratos-server"];

/** The server core, resolved from source (M6 builds the orders server with it). */
export const serverCore: typeof createServer = createServer;
