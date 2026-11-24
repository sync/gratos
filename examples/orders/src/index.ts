import { packageName as gratsPackage } from "@gratos/grats";
import { packageName as serverPackage } from "@gratos/server";

/** The workspace packages this example is built on. M6 replaces this module with the orders app. */
export const dependsOn: ReadonlyArray<string> = [gratsPackage, serverPackage];
