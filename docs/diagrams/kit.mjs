// Loads the anatomy skill's drawing kit for the diagram build scripts. The skill is installed with
// `npx skills add wheresryan22/anatomy -g`; set ANATOMY_SKILL to use a copy somewhere else.
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SKILL = process.env.ANATOMY_SKILL ?? join(homedir(), ".agents", "skills", "anatomy");
const load = (path) => import(pathToFileURL(join(SKILL, path)).href);

export const k = await load("kit/iso-kit.mjs");
export const G = await load("kit/lathe.mjs");
export const T = await load("kit/tube.mjs");
export const A = await load("kit/audit.mjs");
export const { kitScript } = await load("scripts/inline-kit.mjs");
