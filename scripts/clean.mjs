import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(projectRoot, "dist");

if (basename(outputDirectory) !== "dist" || dirname(outputDirectory) !== projectRoot) {
  throw new Error(`Refusing to clean unexpected path: ${outputDirectory}`);
}

await rm(outputDirectory, { recursive: true, force: true });
