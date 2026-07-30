/**
 * Copies platform-sdk/sga-sdk.js into public/sdk/v1/ before every build.
 *
 * Games load the SDK from this app rather than bundling their own copy, so the
 * file has to be served here — but the source of truth stays in platform-sdk/,
 * next to its README and its tests.
 *
 * Automated because the failure mode of doing it by hand is invisible: the two
 * copies drift, every game keeps loading the stale one, and nothing reports an
 * error. Running on prebuild means the served copy cannot be older than the
 * source.
 *
 * The v1 in the path is a promise. Games deployed today keep loading v1 forever;
 * a breaking protocol change ships as v2 alongside it, and old games go on
 * working without being re-exported. That matters at two hundred games, where
 * re-exporting everything is not a thing anyone will do.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../platform-sdk/sga-sdk.js");
const target = resolve(here, "../public/sdk/v1/sga-sdk.js");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);

console.log("sdk: platform-sdk/sga-sdk.js -> public/sdk/v1/sga-sdk.js");
