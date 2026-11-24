import { packageName as gratosPackage } from "@dblechoc/gratos";
import { packageName as serverPackage } from "@dblechoc/gratos-server";

/** The workspace packages this example is built on. M6 replaces this module with the orders app. */
export const dependsOn: ReadonlyArray<string> = [gratosPackage, serverPackage];
