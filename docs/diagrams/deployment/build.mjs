// Fig 2: how GitHub Actions deploys SetEmailCategory, drawn as a key-cutting bench beside two locked cabinets.
// node build.mjs [--light] [--audit]   writes deployment.html or deployment-light.html next to this file.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { k, G, A, kitScript } from "../kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";

const WIDTH = 760;
const HEIGHT = 460;

// ---------- Stations: every word here comes from the repo (deploy.yml, Setup-GitHubOidc.ps1, infra/) ----------

const STATIONS = [
  ["run", "Run workflow", "manual only · pull requests just build",
    "Deployment runs only when someone starts build-and-deploy from Actions, Run workflow (workflow_dispatch). Pull requests run the build job alone, which is the required status check on main."],
  ["build", "Build job", "test · publish · app.zip kept 30 days",
    "dotnet test, then dotnet publish ReadyToRun for linux-x64, zipped as app.zip. Bicep and every .bicepparam file are linted. The artifact app is kept for 30 days."],
  ["env", "prod environment", "required reviewer · main or v* only",
    "The deploy job waits for a required reviewer (self-review is prevented) and runs only from main or a v* tag. It is the only job given id-token: write."],
  ["oidc", "OIDC token", "audience api://AzureADTokenExchange",
    "GitHub issues a signed token: issuer token.actions.githubusercontent.com, subject repo:<owner>@<id>/<repo>@<id>:environment:prod, audience api://AzureADTokenExchange."],
  ["identity", "Deployment identity", "federated credential · no secrets",
    "azure/login trades the token for one belonging to id-github-setemailcat-prod, a user-assigned managed identity whose federated credential github-prod trusts only that subject. GitHub holds four IDs (client, tenant, subscription, resource group) and no secrets. Setup-GitHubOidc.ps1, run once by an Owner or User Access Administrator, creates it."],
  ["contributor", "Contributor", "on the resource group only",
    "Contributor on the resource group and nowhere else: it creates and updates the plan, function app, storage, private endpoints and monitoring there."],
  ["rbac", "RBAC Administrator", "3 roles · service principals only",
    "Role Based Access Control Administrator on the resource group, with an ABAC condition: it may only assign or remove Storage Blob Data Owner, Storage Table Data Contributor and Monitoring Metrics Publisher, and only to service principals (the function app's identity)."],
  ["network", "Network grants", "join subnets · read VNet · DNS records",
    "Outside the resource group, on the platform team's network: the custom role SetEmailCategory Network Join (read and join subnets and NSGs) on each subnet, Reader on the VNet, and Private DNS Zone Contributor on the hub zones (pending: open question N2). -UseBuiltInNetworkRole grants Network Contributor instead."],
  ["checks", "Pre-flight checks", "placeholders · network rules · what-if",
    "The job stops while prod.bicepparam still has '<…>' placeholders. Test-NetworkPrerequisites.ps1 then checks the subnets (delegation, size, NSGs, DNS), and az deployment group what-if previews the change."],
  ["infra", "Deploy infrastructure", "main.bicep + prod.bicepparam",
    "az deployment group create with main.bicep and prod.bicepparam: the plan, function app, storage, private endpoints, monitoring, alerts, and the three role assignments to the function's managed identity."],
  ["code", "Deploy code", "config-zip into the app-package blob",
    "az functionapp deployment source config-zip puts app.zip into the app-package blob container, which the function reads with its own identity. Basic-auth publishing is disabled."],
  ["smoke", "Smoke test", "/api/health shows the commit SHA",
    "Polls /api/health (up to 20 × 15 s) until the version contains the commit SHA, checks runningInAzure and acceptingRequests, and expects 401 for an unauthenticated POST."],
].map(([id, name, fact, detail]) => ({ id, name, fact, detail }));

// ---------- World layout (units ≈ px, x and y on the floor, z up) ----------

const PLATE = { x: -210, y: -104, w: 420, d: 208, r: 10 };
const PLATE_H = 12;
const FOOT_H = 5;
const DECK_H = 4;
const GH_DECK = { x: -198, y: -96, w: 178, d: 152, r: 6 };
const RG_DECK = { x: -6, y: -24, w: 204, d: 80, r: 6 };
const NET_DECK = { x: 96, y: -96, w: 102, d: 64, r: 6 };

const RAILS = [68, 80];
const RAIL = { from: -196, to: 194, d: 3, h: 3 };
const BED = { x: -14, y: 65, w: 28, d: 21, r: 2 };
const BED_Z = RAIL.h;
const BED_TOP = BED_Z + 4;
const CRATE = { x: -10, y: 67, w: 20, d: 16, r: 1 };
const CRATE_H = 16;
const HOME = -160;
const GATE_X = -112;
const ARCH_X = 44;

const CAB = { x: 54, y: 2, w: 96, d: 44, r: 3 };
const X = CAB.x - 40;
const CAB_Z = DECK_H + 4;
const CAB_TOP = 56;
const FRONT = CAB.y + CAB.d;
const SLED = { x: 108, w: 32, out: 18, z: 13, h: 3 };
const SLED_TOP = SLED.z + SLED.h;
const SLED_X = SLED.x + SLED.w / 2;
const NET = { x: 104, y: -90, w: 84, d: 52, r: 3 };
const NET_TOP = 58;
const NET_SIDE = NET.x + NET.w;

const P = k.fitProjection(
  [...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0), [180, 36, 90], [70, 25, 90], [125, 16, 74], [ARCH_X, 90, 56], [HOME, 90, 66], [104, -90, 72]],
  WIDTH,
  HEIGHT,
  { pad: 30, azimuth: 40 },
);
const V = G.viewOf(P);
const toward = k.towardViewer(P);

const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);

// ---------- Recording helpers: every drawn solid records its true shape for the audit ----------

const R = A.recorder(P);
const lineOnTop = (...args) => k.lineOnTop(...args);

function put(st, at3, svg, shapes, o = {}) {
  return R.put({ piece: st, at: at3, bias: o.bias ?? 0, name: o.name, svg, shapes: shapes.map(R.solid), mv: o.mv ?? "", layer: o.layer ?? "back", attrs: o.attrs ?? "" });
}

function slab(st, name, plan, z, h, o = {}) {
  const steps = o.steps ?? 4;
  const svg = S(k.slabOf(plan, z, h, P, steps, o.bevel ?? 0), { tone: o.tone ?? "mid", crease: o.crease, inner: o.inner }) + (o.extra ?? "");
  return put(st, [plan.x + plan.w / 2, plan.y + plan.d / 2, z + h / 2], svg, [A.slab(plan, z, h, { name, ground: o.ground }, steps)], { ...o, name });
}

function cyl(st, name, cx, cy, r, z, h, o = {}) {
  const svg = S(k.cylinder(cx, cy, r, z, h, P, o.steps ?? 28, o.bevel ?? 0), { tone: o.tone ?? "mid", crease: o.crease, inner: o.inner }) + (o.extra ?? "");
  return put(st, [cx, cy, z + h / 2], svg, [A.cylinder(cx, cy, r, z, h, { name, ground: o.ground })], { ...o, name });
}

function disc(st, name, F, s0, s1, r, o = {}) {
  const svg = S(G.disc(s0, s1, r, F, P), { tone: o.tone ?? "mid", crease: o.crease, inner: o.inner }) + (o.extra ?? "");
  return put(st, G.pointOf(F, (s0 + s1) / 2, 0, 0), svg, [A.disc(F, s0, s1, r, { name })], { ...o, name });
}

function prism(st, name, F, polygon, s0, s1, o = {}) {
  const svg = S(G.prismOf(F, polygon, s0, s1, P), { tone: o.tone ?? "mid", crease: o.crease }) + (o.extra ?? "");
  const cx = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length;
  const cy = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
  return put(st, G.add3(G.pointOf(F, (s0 + s1) / 2, 0, 0), G.add3(G.mul3(F.u, cx), G.mul3(F.v, cy))), svg, [A.prism(F, polygon, s0, s1, { name })], { ...o, name });
}

const circle = (cx, cy, r, n = 18) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
const facing = (axis) => (G.dot3(axis, [toward[0], toward[1], 0]) >= 0 ? axis : G.mul3(axis, -1));
const screwRing = (points, z, r = 1.4) => L(points.map(([x, y]) => k.ring(x, y, r, z, P, 12)).join(""), { tone: "lo" }) + D(points.map(([x, y]) => at([x, y, z])), { size: 0.45 });

// A lock on a vertical face (or a top), with its key standing out of it. `o` is the face point, `d` the outward
// normal. The key is a flat bow and shank in the plane of `d` and `side`, so it reads as a key from this camera.
function lock(st, name, o, d, side, { mv = "", turnable = true } = {}) {
  const F = G.frameAlong(o, d);
  disc(st, `${name}.housing`, F, 0, 1.6, 3, { tone: "mid", extra: L(G.circleOf(F, 1.6, 2.1, P, 32), { tone: "faint" }) });
  if (!turnable) return;
  const thick = facing(G.unit3(G.cross3(d, side)));
  const base = G.add3(o, G.mul3(d, 1.6));
  const KF = G.frameOf(base, thick, d, side);
  const ringOn = G.circleOf(G.frameAlong(G.add3(base, G.mul3(d, 8.6)), thick), 0.45, 1.3, P, 24);
  prism(st, `${name}.shank`, KF, [[0, -0.75], [5.4, -0.75], [5.4, 0.75], [0, 0.75]], -0.45, 0.45, { tone: "hi", mv });
  prism(st, `${name}.bow`, KF, circle(8.6, 0, 3.4, 20), -0.45, 0.45, { tone: "hi", mv, extra: L(ringOn, { tone: "lo" }) });
}

// ---------- The bench ----------

const halo = `<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`;

function bench() {
  for (const [x, y] of k.corners(PLATE, 22)) {
    cyl("", "stand.flange", x, y, 7, -PLATE_H - FOOT_H, 1.6, { tone: "lo" });
    cyl("", "stand.foot", x, y, 5.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, { tone: "mid" });
  }
  const screws = k.corners(PLATE, 9);
  slab("", "stand.plate", PLATE, -PLATE_H, PLATE_H, {
    steps: 8, bevel: 1.6,
    extra: L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }) + screwRing(screws, 0, 2.2),
  });
  // Ruler strip along the front: the shuttle's travel.
  const strip = { x: -130, y: 96, w: 270, d: 5, r: 1 };
  const ticks = k.topTicks(strip.x + 3, strip.x + strip.w - 3, 5, 5, strip.y + 0.6, 0.6, [1.8, 3.2], P);
  slab("", "stand.ruler", strip, 0, 0.6, { tone: "lo", crease: "none", steps: 3, extra: L(ticks.minor, { tone: "lo" }) + L(ticks.major, { tone: "mid" }) + D([at([strip.x + 1.5, strip.y + 2.5, 0.6]), at([strip.x + strip.w - 1.5, strip.y + 2.5, 0.6])], { size: 0.4 }) });
  const label = { x: 150, y: 88, w: 34, d: 11, r: 1.2 };
  slab("", "stand.label", label, 0, 0.8, {
    tone: "lo", crease: "none", steps: 3,
    extra: L(k.planOutline(k.insetPlan(label, 1.4), 0.8, P, 3), { tone: "faint" }) +
      L([24, 16, 20].map((w, i) => k.lineOnTop([label.x + 4, label.y + 3 + i * 2.6], [label.x + 4 + w, label.y + 3 + i * 2.6], 0.8, P)).join(""), { tone: "lo", free: true }) +
      D([at([label.x + label.w - 3, label.y + 3, 0.8]), at([label.x + label.w - 3, label.y + label.d - 3, 0.8])], { size: 0.4 }),
  });
  for (const deck of [GH_DECK, RG_DECK, NET_DECK]) {
    const pts = k.corners(deck, 6);
    slab("", `stand.deck${deck.x}`, deck, 0, DECK_H, { tone: "lo", steps: 6, bevel: 0.8, extra: L(k.planOutline(k.insetPlan(deck, 3.5), DECK_H, P), { tone: "faint" }) + screwRing(pts, DECK_H) });
  }
  // Rails with end stops.
  for (const y of RAILS) slab("", `stand.rail${y}`, { x: RAIL.from, y, w: RAIL.to - RAIL.from, d: RAIL.d, r: 0.8 }, 0, RAIL.h, { tone: "mid", steps: 3, bevel: 0.4, extra: D([RAIL.from + 6, RAIL.to - 6].map((x) => at([x, y + 1.5, RAIL.h])), { size: 0.4 }) });
  for (const x of [RAIL.from - 5, RAIL.to]) slab("", `stand.stop${x}`, { x, y: 64, w: 5, d: 23, r: 1.2 }, 0, 8, { tone: "mid", steps: 3, bevel: 0.5, extra: D([at([x + 2.5, 67, 8]), at([x + 2.5, 84, 8])], { size: 0.45 }) });
}

// ---------- 01 Run workflow: a mushroom start button ----------

function startButton() {
  const c = [-150, 6];
  slab("run", "run.pedestal", { x: c[0] - 11, y: c[1] - 11, w: 22, d: 22, r: 2.5 }, DECK_H, 7, { tone: "mid", bevel: 0.6, extra: screwRing(k.corners({ x: c[0] - 11, y: c[1] - 11, w: 22, d: 22, r: 2.5 }, 3), DECK_H + 7, 0.9) });
  cyl("run", "run.collar", c[0], c[1], 7, DECK_H + 7, 3, { tone: "mid", inner: L(k.sideArc(c[0], c[1], 7, DECK_H + 8.5, P, 24), { tone: "faint" }) });
  cyl("run", "run.stem", c[0], c[1], 3.4, DECK_H + 10, 3, { tone: "mid", crease: "none" });
  cyl("run", "run.cap", c[0], c[1], 6, DECK_H + 13, 3.4, { tone: "hi", bevel: 0.6, mv: "button", extra: L(k.ring(c[0], c[1], 3.6, DECK_H + 16.4, P, 28), { tone: "faint" }) });
}

// The workflow file the button runs, clipped to a holder: build-and-deploy.
function workflow() {
  const holder = { x: -128, y: -90, w: 58, d: 42, r: 2 };
  slab("run", "run.holder", holder, DECK_H, 2, { tone: "lo", steps: 3, extra: D(k.corners(holder, 2).map(([x, y]) => at([x, y, DECK_H + 2])), { size: 0.4 }) });
  const sheet = { x: -124, y: -84, w: 50, d: 33, r: 0.6 };
  const rows = [[0, 18], [3, 22], [3, 14], [0, 16], [3, 26], [6, 20], [6, 30], [3, 12], [6, 24]];
  const lines = rows.map(([indent, w], i) => k.lineOnTop([sheet.x + 4 + indent, sheet.y + 4 + i * 3.2], [sheet.x + 4 + indent + w, sheet.y + 4 + i * 3.2], DECK_H + 2.6, P)).join("");
  slab("run", "run.sheet", sheet, DECK_H + 2, 0.6, { tone: "hi", steps: 2, extra: L(lines, { tone: "lo", free: true }) });
  for (const x of [sheet.x + 8, sheet.x + sheet.w - 14]) slab("run", "run.clip", { x, y: sheet.y - 3, w: 6, d: 5, r: 1 }, DECK_H + 2.6, 1.4, { tone: "mid", steps: 2, extra: D([at([x + 3, sheet.y - 1.4, DECK_H + 4])], { size: 0.4 }) });
}

// ---------- 02 Build job: a press over the rail that stamps the crate ----------

function press() {
  const posts = [[HOME - 14, 60], [HOME + 14, 60], [HOME - 14, 91], [HOME + 14, 91]];
  for (const [x, y] of posts) {
    const front = y > 80;
    cyl("build", "build.foot", x, y, 4.4, 0, 2, { tone: "lo", layer: front ? "front" : "back" });
    cyl("build", "build.post", x, y, 2.6, 2, 54, { tone: "mid", crease: "none", inner: L([18, 36].map((z) => k.sideArc(x, y, 2.6, z, P, 14)).join(""), { tone: "faint" }), layer: front ? "front" : "back" });
  }
  const head = { x: HOME - 20, y: 55, w: 40, d: 41, r: 3 };
  slab("build", "build.crosshead", head, 56, 8, { tone: "mid", bevel: 0.8, layer: "front", inner: L(k.sideSeam(head, 60, P, 4), { tone: "faint" }), extra: screwRing(posts, 64, 1.6) });
  cyl("build", "build.cylinder", HOME, 75.5, 7, 64, 6, { tone: "mid", layer: "front", extra: L(k.ring(HOME, 75.5, 4.2, 70, P, 32), { tone: "faint" }) });
  cyl("build", "build.ram", HOME, 75.5, 3, 30, 26, { tone: "hi", crease: "none", mv: "ram", layer: "front", inner: L(k.sideArc(HOME, 75.5, 3, 44, P, 16), { tone: "faint" }) });
  cyl("build", "build.platen", HOME, 75.5, 7, 27, 3, { tone: "hi", mv: "ram", layer: "front" });
}

// ---------- 03 prod environment: a gate across the rail, and the reviewer's key switch ----------

function gate() {
  const pillars = [{ x: GATE_X - 4, y: 57, w: 8, d: 6, r: 1.2 }, { x: GATE_X - 4, y: 88, w: 8, d: 6, r: 1.2 }];
  pillars.forEach((plan, i) => slab("env", "env.pillar", plan, 0, 50, { tone: "mid", bevel: 0.5, layer: i ? "front" : "back", inner: L(k.sideSeam(plan, 46, P, 4), { tone: "faint" }), extra: D([at([plan.x + 4, plan.y + 3, 50])], { size: 0.5 }) }));
  const bar = { x: GATE_X - 2, y: 63, w: 4, d: 25, r: 0.8 };
  slab("env", "env.bar", bar, 12, 4, { tone: "hi", steps: 3, mv: "bar", layer: "front", extra: L([70, 75, 80].map((y) => k.lineOnTop([bar.x, y], [bar.x + bar.w, y], 16, P)).join(""), { tone: "lo" }) });
  // The reviewer's key switch on the back pillar: the gate opens only once a reviewer approves.
  lock("env", "env.key", [GATE_X + 4, 60, 32], [1, 0, 0], [0, 0, 1], { mv: "gatekey" });
}

// ---------- 04 OIDC token: a punched card from GitHub's dispenser, on a track across the gap ----------

const TRACK = { x: -96, y: -3, w: 60, d: 10, r: 1 };
const CARD = { x: -92, y: -1, w: 30, d: 6, r: 0.6 };
const CARD_TRAVEL = 50;

function token() {
  slab("oidc", "oidc.track", TRACK, DECK_H, 2, { tone: "lo", steps: 3, extra: L(k.lineOnTop([TRACK.x, TRACK.y + 1.5], [TRACK.x + TRACK.w, TRACK.y + 1.5], DECK_H + 2, P) + k.lineOnTop([TRACK.x, TRACK.y + TRACK.d - 1.5], [TRACK.x + TRACK.w, TRACK.y + TRACK.d - 1.5], DECK_H + 2, P), { tone: "faint" }) });
  const hopper = { x: -114, y: -11, w: 18, d: 26, r: 2 };
  slab("oidc", "oidc.dispenser", hopper, DECK_H, 16, { tone: "mid", bevel: 0.6, inner: L(k.sideSeam(hopper, DECK_H + 12, P, 4), { tone: "faint" }), extra: L(k.planOutline({ x: hopper.x + 4, y: hopper.y + 5, w: 10, d: 16, r: 1 }, DECK_H + 16, P, 3), { tone: "lo" }) + D(k.corners(hopper, 2.5).map(([x, y]) => at([x, y, DECK_H + 16])), { size: 0.4 }) });
  // The card: three rows of punched holes, the issuer, subject and audience the reader checks.
  const holes = [[-86, 0.4], [-82, 2.8], [-76, 1.2], [-72, 3.6], [-67, 0.8], [-70, 2.2]].map(([x, y]) => k.ring(x, y, 0.8, DECK_H + 2.8, P, 10)).join("");
  slab("oidc", "oidc.card", CARD, DECK_H + 2, 0.8, { tone: "hi", steps: 2, mv: "card", extra: L(holes, { tone: "lo" }) + L(k.lineOnTop([CARD.x + 26, CARD.y], [CARD.x + 26, CARD.y + CARD.d], DECK_H + 2.8, P), { tone: "faint" }) });
}

// ---------- 05 Deployment identity: the three-pin reader, the key ring it releases, GitHub's four ID tags ----------

const READER = { x: -36, y: -12, w: 30, d: 26, r: 2 };
const READER_TOP = 24;

function reader() {
  slab("identity", "identity.reader", READER, DECK_H, READER_TOP - DECK_H, { tone: "mid", bevel: 0.8, inner: L(k.sideSeam(READER, 9, P, 4) + k.sideSeam(READER, 20, P, 4), { tone: "faint" }), extra: L(k.planOutline(k.insetPlan(READER, 3), READER_TOP, P, 3), { tone: "faint" }) + D(k.corners(READER, 2.2).map(([x, y]) => at([x, y, READER_TOP])), { size: 0.4 }) });
  [-28, -21, -14].forEach((x) => {
    cyl("identity", "identity.bushing", x, -3, 2.6, READER_TOP, 1.6, { tone: "lo" });
    cyl("identity", "identity.pin", x, -3, 1.3, READER_TOP + 1.6, 4, { tone: "hi", mv: "pins", extra: L(k.ring(x, -3, 0.6, READER_TOP + 5.6, P, 10), { tone: "faint" }) });
  });
  // Key ring hanging from a bracket on the reader's front.
  const bracket = { x: -24, y: READER.y + READER.d, w: 6, d: 3, r: 0.6 };
  slab("identity", "identity.bracket", bracket, 21, 3, { tone: "mid", steps: 2 });
  const RF = G.frameAlong([-21, bracket.y + 1.5, 21 - 4.1], [0, 1, 0]);
  const ring = G.ringBand(-0.6, 0.6, 3.3, 4.4, RF, P);
  put("identity", RF.o, S(ring, { tone: "hi" }), [A.ring(RF, -0.6, 0.6, 3.3, 4.4, { name: "identity.ring" })], { name: "identity.ring" });
  const KF = G.frameOf([-21, bracket.y + 1.5, 21 - 8.4], [0, 1, 0], [0, 0, -1], [1, 0, 0]);
  prism("identity", "identity.tagbow", KF, circle(2, 0, 2, 18), -0.4, 0.4, { tone: "hi" });
  prism("identity", "identity.tagshank", KF, [[3.8, -0.7], [7.6, -0.7], [7.6, 0.7], [3.8, 0.7]], -0.4, 0.4, { tone: "hi" });
  // GitHub's environment variables: four IDs, no secrets.
  const board = { x: -190, y: -84, w: 52, d: 30, r: 2 };
  slab("identity", "identity.board", board, DECK_H, 2, { tone: "lo", steps: 3, extra: D(k.corners(board, 2).map(([x, y]) => at([x, y, DECK_H + 2])), { size: 0.4 }) });
  for (let i = 0; i < 4; i++) {
    const tag = { x: board.x + 3 + i * 12, y: board.y + 4, w: 10, d: 22, r: 1 };
    slab("identity", "identity.tag", tag, DECK_H + 2, 0.6, { tone: "hi", steps: 2, extra: L([6, 4, 5].map((w, j) => k.lineOnTop([tag.x + 2, tag.y + 4 + j * 3], [tag.x + 2 + w, tag.y + 4 + j * 3], DECK_H + 2.6, P)).join(""), { tone: "lo", free: true }) + L(k.ring(tag.x + 5, tag.y + 17, 1, DECK_H + 2.6, P, 12), { tone: "faint" }) });
  }
}

// ---------- The resource group cabinet: 06 door key, 07 role stamp, 10 drawers and lamps, 11 sled, 12 button ----------

function cabinet() {
  slab("infra", "infra.plinth", k.insetPlan(CAB, 2), DECK_H, CAB_Z - DECK_H, { tone: "lo", steps: 4 });
  slab("infra", "infra.cabinet", CAB, CAB_Z, CAB_TOP - CAB_Z, {
    tone: "mid", steps: 4, bevel: 1.2,
    inner: L(k.sideSeam(CAB, CAB_TOP - 4, P, 4), { tone: "faint" }),
    extra: L(k.planOutline(k.insetPlan(CAB, 4), CAB_TOP, P, 4), { tone: "faint" }) + screwRing(k.corners(CAB, 3), CAB_TOP, 1),
  });
  // Door with the Contributor lock.
  const door = { x: 46 + X, y: FRONT, w: 40, d: 1.2, r: 0.4 };
  slab("contributor", "contributor.door", door, 12, 40, { tone: "mid", steps: 2, extra: hinges(door, 12, 52) });
  lock("contributor", "contributor.lock", [78 + X, FRONT + 1.2, 32], [0, 1, 0], [0, 0, 1], { mv: "ckey" });
  // Drawer fronts for what the deployment creates, and five lamps: plan, function app, storage, monitoring, alerts.
  for (const [z0, z1] of [[19, 29], [31, 41]]) {
    const front = { x: 92 + X, y: FRONT, w: 36, d: 1.2, r: 0.4 };
    slab("infra", "infra.drawer", front, z0, z1 - z0, { tone: "mid", steps: 2, extra: pull(110 + X, z0 + 3) + holder(110 + X, z1 - 3) });
  }
  const strip = { x: 92 + X, y: FRONT, w: 36, d: 1, r: 0.3 };
  // Five lamps, one per kind of resource the deployment creates: plan, function app, storage, monitoring, alerts.
  const lenses = [97, 103.5, 110, 116.5, 123].map((x, i) => `<path class="dp-lens" data-lamp="${i}" d="${k.sideRing([x + X, FRONT + 1, 47.5], 1.7, "y", P, 40)}"/>`).join("");
  slab("infra", "infra.lampstrip", strip, 44, 7, { tone: "lo", steps: 2, extra: lenses });
  // Side of the cabinet: vent slots and a rating plate.
  const SIDE = CAB.x + CAB.w;
  const onSide = (points) => k.pathOf(points.map(([y, z]) => at([SIDE + 0.2, y, z])), true);
  const vents = Array.from({ length: 9 }, (_, i) => onSide([[9 + i * 3.6, 38], [10.2 + i * 3.6, 38], [10.2 + i * 3.6, 50], [9 + i * 3.6, 50]])).join("");
  const plate = onSide([[12, 14], [36, 14], [36, 27], [12, 27]]);
  const rules = [16, 10, 13].map((w, i) => k.segment([SIDE + 0.2, 15, 24 - i * 3], [SIDE + 0.2, 15 + w, 24 - i * 3], P)).join("");
  slab("infra", "infra.sidepanel", { x: SIDE, y: 6, w: 0.2, d: 34, r: 0 }, 10, 44, { tone: "mid", steps: 1, crease: "none", extra: L(vents, { tone: "faint" }) + L(plate, { tone: "lo" }) + L(rules, { tone: "lo", free: true }) + D([at([SIDE + 0.2, 34, 24]), at([SIDE + 0.2, 34, 17])], { size: 0.4 }) });
  // The storage sled, closed: its front plate sits in a slot in the face.
  const sledFront = { x: SLED.x - 2, y: FRONT, w: SLED.w + 4, d: 1.2, r: 0.4 };
  slab("code", "code.sledfront", sledFront, SLED.z - 2, SLED.h + 2, { tone: "hi", steps: 2, mv: "sled", layer: "sled", extra: pull(SLED_X, SLED.z + 0.4, 1.4) });
  // Template slot on the top: main.bicep and prod.bicepparam, standing in it.
  const slot = { x: 96 + X, y: 12, w: 30, d: 8, r: 1.2 };
  slab("infra", "infra.slot", slot, CAB_TOP, 1.6, { tone: "lo", steps: 3, extra: D([at([slot.x + 2, slot.y + 4, CAB_TOP + 1.6]), at([slot.x + slot.w - 2, slot.y + 4, CAB_TOP + 1.6])], { size: 0.4 }) });
  const card = { x: 99 + X, y: 15.4, w: 24, d: 1.2, r: 0.3 };
  const punch = [104, 108, 112, 116, 106, 114].map((x, i) => k.sideRing([x + X, card.y + card.d, CAB_TOP + (i < 4 ? 10 : 6)], 0.8, "y", P, 10)).join("");
  slab("infra", "infra.template", card, CAB_TOP + 1.6, 14, { tone: "hi", steps: 2, extra: L(punch, { tone: "lo" }) });
  // 07: the role stamp on a bridge, with its guard of three pins (the only three roles it may assign).
  for (const y of [14, 36]) cyl("rbac", "rbac.post", 56 + X, y, 2.2, CAB_TOP, 26, { tone: "mid", crease: "none", inner: L(k.sideArc(56 + X, y, 2.2, CAB_TOP + 13, P, 14), { tone: "faint" }) });
  const beam = { x: 52 + X, y: 10, w: 8, d: 30, r: 1.2 };
  slab("rbac", "rbac.beam", beam, CAB_TOP + 26, 5, { tone: "mid", bevel: 0.5, steps: 3, extra: D([at([56 + X, 14, CAB_TOP + 31]), at([56 + X, 36, CAB_TOP + 31])], { size: 0.45 }) });
  const guard = { x: 60 + X, y: 14, w: 5, d: 22, r: 1 };
  slab("rbac", "rbac.guard", guard, CAB_TOP + 27, 3, { tone: "lo", steps: 2 });
  [18.5, 25, 31.5].forEach((y) => cyl("rbac", "rbac.rolepin", 62.5 + X, y, 1.1, CAB_TOP + 30, 3, { tone: "hi", steps: 14 }));
  cyl("rbac", "rbac.ram", 56 + X, 25, 2.6, CAB_TOP + 10, 16, { tone: "hi", crease: "none", mv: "stamp" });
  slab("rbac", "rbac.head", { x: 51 + X, y: 20, w: 10, d: 10, r: 1 }, CAB_TOP + 6, 4, { tone: "hi", steps: 3, mv: "stamp", bevel: 0.4 });
  const badge = { x: 47 + X, y: 18, w: 18, d: 14, r: 1.4 };
  slab("rbac", "rbac.badge", badge, CAB_TOP, 1, { tone: "lo", steps: 3, extra: L(k.planOutline(k.insetPlan(badge, 2), CAB_TOP + 1, P, 3), { tone: "faint" }) + D([at([badge.x + 2.2, badge.y + 2.2, CAB_TOP + 1])], { size: 0.4 }) });
}

function hinges(door, z0, z1) {
  return [z0 + 6, z1 - 10].map((z) => L(k.segment([door.x + 3, door.y + door.d, z], [door.x + 3, door.y + door.d, z + 4], P), { tone: "lo" }) + D([at([door.x + 3, door.y + door.d, z]), at([door.x + 3, door.y + door.d, z + 4])], { size: 0.4 })).join("");
}

function pull(x, z, size = 1) {
  return L(k.segment([x - 5 * size, FRONT + 1.2, z], [x + 5 * size, FRONT + 1.2, z], P), { tone: "hi" }) + D([at([x - 5 * size, FRONT + 1.2, z]), at([x + 5 * size, FRONT + 1.2, z])], { size: 0.5, tone: "mid" });
}

function holder(x, z) {
  const ring = [[x - 6, z - 1.6], [x + 6, z - 1.6], [x + 6, z + 1.6], [x - 6, z + 1.6]].map(([u, w]) => at([u, FRONT + 1.2, w]));
  return L(k.pathOf(ring, true), { tone: "faint" });
}

// ---------- 08 The platform team's network cabinet, in another resource group ----------

function network() {
  slab("network", "network.plinth", k.insetPlan(NET, 2), DECK_H, 4, { tone: "lo", steps: 4 });
  const face = (u, z) => [NET_SIDE, u, z];
  const window = k.pathOf([[-84, 40], [-44, 40], [-44, 53], [-84, 53]].map(([u, z]) => at(face(u, z))), true);
  const glass = [-80, -74, -68, -62, -56, -50].map((u) => k.segment(face(u, 40), face(u + 4.5, 53), P)).join("");
  const grilles = [-78, -62].flatMap((u) => [-7, -5, 5, 7].map((dz) => k.pathOf([[u - 5, 24 + dz - 0.5], [u + 5, 24 + dz - 0.5], [u + 5, 24 + dz + 0.5], [u - 5, 24 + dz + 0.5]].map(([v, z]) => at(face(v, z))), true))).join("");
  slab("network", "network.cabinet", NET, 8, NET_TOP - 8, {
    tone: "mid", steps: 4, bevel: 1.2,
    inner: L(k.sideSeam(NET, NET_TOP - 4, P, 4), { tone: "faint" }),
    extra: L(window, { tone: "lo" }) + L(glass, { tone: "faint" }) + L(grilles, { tone: "faint" }) + screwRing(k.corners(NET, 3), NET_TOP, 1),
  });
  // The shared VNet's other subnets, as a row of blank panels on the long face: other workloads use this VNet too.
  const FACE_Y = NET.y + NET.d + 0.2;
  const onFace = (points) => k.pathOf(points.map(([x, z]) => at([x, FACE_Y, z])), true);
  const panels = [112, 126, 140, 154, 168].map((x) => onFace([[x, 16], [x + 10, 16], [x + 10, 46], [x, 46]]) + k.sideRing([x + 5, FACE_Y, 38], 2, "y", P, 28)).join("");
  const screws = [112, 126, 140, 154, 168].flatMap((x) => [at([x + 5, FACE_Y, 19]), at([x + 5, FACE_Y, 43])]);
  slab("network", "network.face", { x: NET.x + 4, y: NET.y + NET.d, w: NET.w - 8, d: 0.2, r: 0 }, 12, 38, { tone: "mid", steps: 1, crease: "none", extra: L(panels, { tone: "faint" }) + D(screws, { size: 0.4 }) });
  // Two subnet sockets that the join-only key fits, and the Reader lock under the VNet window.
  lock("network", "network.subnetA", [NET_SIDE, -78, 24], [1, 0, 0], [0, 0, 1], { mv: "nkey" });
  lock("network", "network.subnetB", [NET_SIDE, -62, 24], [1, 0, 0], [0, 0, 1], { mv: "nkey" });
  lock("network", "network.reader", [NET_SIDE, -46, 24], [1, 0, 0], [0, 0, 1], { mv: "nkey" });
  // The hub DNS card index on the top, with its own key.
  const box = { x: 144, y: -82, w: 32, d: 24, r: 1.6 };
  slab("network", "network.index", box, NET_TOP, 10, { tone: "mid", steps: 3, bevel: 0.5, extra: L(k.planOutline(k.insetPlan(box, 2), NET_TOP + 10, P, 3), { tone: "lo" }) });
  [-78, -73, -68, -63].forEach((y, i) => slab("network", "network.dnscard", { x: box.x + 4, y, w: 24, d: 1, r: 0.3 }, NET_TOP + 10, i === 1 ? 6 : 4, { tone: "hi", steps: 2 }));
  lock("network", "network.dns", [box.x + box.w, -70, NET_TOP + 5], [1, 0, 0], [0, 0, 1], { mv: "nkey" });
}

// ---------- 09 Pre-flight checks: an arch over the rail with three dial gauges ----------

const DIALS = [62, 75, 88].map((y) => [ARCH_X, y]);
const DIAL_R = 5.2;
const ARCH_TOP = 50;

function arch() {
  const posts = [{ x: ARCH_X - 4, y: 57, w: 8, d: 6, r: 1.2 }, { x: ARCH_X - 4, y: 88, w: 8, d: 6, r: 1.2 }];
  posts.forEach((plan, i) => slab("checks", "checks.post", plan, 0, ARCH_TOP - 6, { tone: "mid", bevel: 0.5, layer: i ? "front" : "back", inner: L(k.sideSeam(plan, 36, P, 4), { tone: "faint" }) }));
  const beam = { x: ARCH_X - 8, y: 55, w: 16, d: 41, r: 2 };
  slab("checks", "checks.beam", beam, ARCH_TOP - 6, 6, { tone: "mid", bevel: 0.6, layer: "front", extra: D([at([ARCH_X, 57, ARCH_TOP]), at([ARCH_X, 94, ARCH_TOP])], { size: 0.45 }) });
  DIALS.forEach(([x, y]) => {
    const ticks = k.radialTicks(x, y, DIAL_R - 1, 30, 5, ARCH_TOP + 3, [0.9, 1.8], P);
    cyl("checks", "checks.dial", x, y, DIAL_R, ARCH_TOP, 3, { tone: "hi", crease: "lo", steps: 40, layer: "front", extra: L(k.ring(x, y, DIAL_R - 0.8, ARCH_TOP + 3, P, 40), { tone: "lo" }) + L(ticks.minor, { tone: "lo" }) + L(ticks.major, { tone: "mid" }) + L(k.ring(x, y, 0.7, ARCH_TOP + 3, P, 10), { tone: "mid" }) });
  });
}

const needleAt = (x, y, turn) => {
  const a = turn * Math.PI * 2;
  return lineOnTop([x - Math.sin(a) * 0.7, y + Math.cos(a) * 0.7], [x + Math.sin(a) * 3.6, y - Math.cos(a) * 3.6], 53.2, P);
};

// ---------- 12 Smoke test: a probe on a post, over the health button on the cabinet top ----------

function probe() {
  const c = [180, 34];
  cyl("smoke", "smoke.base", c[0], c[1], 7, DECK_H, 3, { tone: "lo", extra: screwRing([[c[0] - 4.2, c[1] - 4.2], [c[0] + 4.2, c[1] + 4.2]], DECK_H + 3, 0.8) });
  cyl("smoke", "smoke.post", c[0], c[1], 2.6, DECK_H + 3, 78 - DECK_H - 3, { tone: "mid", crease: "none", inner: L([30, 56].map((z) => k.sideArc(c[0], c[1], 2.6, z, P, 14)).join(""), { tone: "faint" }) });
  const clamp = { x: c[0] - 5, y: c[1] - 5, w: 10, d: 10, r: 2 };
  slab("smoke", "smoke.clamp", clamp, 78, 8, { tone: "mid", steps: 3, bevel: 0.5 });
  cyl("smoke", "smoke.cap", c[0], c[1], 2.6, 86, 2.4, { tone: "mid", bevel: 0.3 });
  const B = 136;
  const arm = { x: B - 5, y: 31.5, w: 175 - B + 5, d: 5, r: 1.4 };
  slab("smoke", "smoke.arm", arm, 80, 4, { tone: "mid", steps: 3, bevel: 0.4, extra: D([at([arm.x + 3, 34, 84]), at([arm.x + arm.w - 3, 34, 84])], { size: 0.4 }) });
  cyl("smoke", "smoke.plunger", B, 34, 1.3, 64, 16, { tone: "hi", crease: "none", mv: "probe" });
  cyl("smoke", "smoke.tip", B, 34, 2.2, 62, 2, { tone: "hi", mv: "probe" });
  cyl("smoke", "smoke.buttonbase", B, 34, 4, CAB_TOP, 2, { tone: "lo" });
  cyl("smoke", "smoke.button", B, 34, 2.6, CAB_TOP + 2, 1.4, { tone: "hi", extra: L(k.ring(B, 34, 1.4, CAB_TOP + 3.4, P, 16), { tone: "faint" }) });
}

// ---------- The shuttle and the app.zip crate ----------

function shuttle() {
  const bed = { ...BED, x: HOME + BED.x };
  slab("", "shuttle.bed", bed, BED_Z, 4, { tone: "mid", steps: 3, bevel: 0.5, mv: "shuttle", layer: "shuttle", extra: D(k.corners(bed, 2).map(([x, y]) => at([x, y, BED_TOP])), { size: 0.45 }) });
  const crate = { ...CRATE, x: HOME + CRATE.x };
  const top = BED_TOP + CRATE_H;
  const straps = [crate.x + 5, crate.x + 15].map((x) => k.segment([x, crate.y + crate.d, BED_TOP], [x, crate.y + crate.d, top], P) + k.lineOnTop([x, crate.y], [x, crate.y + crate.d], top, P)).join("");
  slab("build", "build.crate", crate, BED_TOP, CRATE_H, {
    tone: "hi", steps: 2, bevel: 0.5, mv: "crate", layer: "shuttle",
    inner: L(k.sideSeam(crate, top - 3, P, 2), { tone: "lo" }),
    extra: L(straps, { tone: "lo" }),
  });
}

// ---------- Build everything, settle the painter's order, audit ----------

bench();
startButton();
workflow();
press();
gate();
token();
reader();
cabinet();
network();
arch();
probe();
shuttle();

A.settle(R, P);
R.items.sort((a, b) => a.key - b.key);
// The shuttle runs on the rails between the back and front rows; nothing on the bench crosses its lane.
const LAYERS = ["back", "sled", "shuttle", "front"];
const ordered = LAYERS.flatMap((layer) => R.items.filter((item) => item.layer === layer));
ordered.forEach((item, index) => (item.key = index));
R.items.splice(0, R.items.length, ...ordered);
A.auditOrExit(R, P, { allow: [] });

const itemSvg = (item) => `<g class="it" data-st="${item.piece}"${item.mv ? ` data-mv="${item.mv}"` : ""}${item.attrs}>${item.svg}</g>`;
const back = ordered.filter((item) => item.layer === "back").map(itemSvg).join("");
const sled = ordered.filter((item) => item.layer === "sled").map(itemSvg).join("");
const lane = ordered.filter((item) => item.layer === "shuttle").map(itemSvg).join("");
const front = ordered.filter((item) => item.layer === "front").map(itemSvg).join("");
const needles = DIALS.map(([x, y], i) => `<path class="iso-line dp-needle" data-tone="hi" data-free="start" data-needle="${i}" d="${needleAt(x, y, 0.06)}" style="stroke-width:.8"/>`).join("");
const shelf = `<g class="it" data-st="code" data-shelf></g>`;

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label:
    "A key-cutting bench beside two locked cabinets, showing how GitHub Actions deploys SetEmailCategory. On the GitHub deck a start button, a press that stamps the app crate, a token dispenser and a reviewer's key gate; a punched card slides across into a three-pin reader that releases a key ring. Keys sit in the locks they open: the resource-group cabinet door, a role stamp guarded to three roles, and the platform network cabinet's two subnet sockets, VNet window and DNS card index. A shuttle carries the crate under a gauge arch to the cabinet's storage sled, and a probe presses the health button.",
  body: [`<g class="dp-art">${halo}${back}${shelf}${sled}<g class="dp-lane">${lane}</g>${front}${needles}</g>`],
});

// ---------- Live page ----------

const DATA = {
  P,
  stations: STATIONS.map(({ id, name, fact }) => ({ id, name, fact })),
  dials: DIALS,
  sled: { x: SLED.x, w: SLED.w, z: SLED.z, h: SLED.h, front: FRONT, out: SLED.out, lift: SLED_TOP - BED_TOP },
  shuttle: { home: 0, wait: 0, arch: ARCH_X - HOME, cabinet: SLED_X - HOME },
  cardTravel: CARD_TRAVEL,
};

const live = `
const D = ${JSON.stringify(DATA)};
const P = D.P;
const root = document.querySelector(".dp");
const stage = root.querySelector(".dp-stage");
const svg = stage.querySelector("svg");
const readout = root.querySelector("[data-readout]");
const detail = root.querySelector("[data-detail]");
const buttons = [...root.querySelectorAll(".dp-part")];
const items = [...svg.querySelectorAll(".it")];
const still = matchMedia("(prefers-reduced-motion: reduce)");
const groups = {};
for (const el of svg.querySelectorAll("[data-mv]")) (groups[el.dataset.mv] ??= []).push(el);
const needles = [...svg.querySelectorAll("[data-needle]")];
const lamps = [...svg.querySelectorAll("[data-lamp]")].sort((a, b) => a.dataset.lamp - b.dataset.lamp);
const shelf = svg.querySelector("[data-shelf]");
const needleAt = ${needleAt.toString()};
const DETAILS = ${JSON.stringify(STATIONS.map((s) => s.detail))};
const n = D.stations.length;
const pad = (i) => String(i + 1).padStart(2, "0");

// Every moving part's offset is a pure function of the selected station (0 = at rest).
function targets(s) {
  const t = {
    button: [0, 0, s === 1 ? -2.4 : 0],
    ram: [0, 0, s === 2 ? -3.6 : 0],
    gatekey: [s >= 3 ? -1.2 : 0, 0, 0],
    bar: [0, 0, s >= 3 ? 27 : 0],
    card: [s >= 4 ? D.cardTravel : 0, 0, 0],
    pins: [0, 0, s >= 5 ? 2.6 : 0],
    ckey: [0, s === 6 ? -1.2 : 0, 0],
    stamp: [0, 0, s === 7 ? -5 : 0],
    nkey: [s === 8 ? -1.2 : 0, 0, 0],
    probe: [0, 0, s === 12 ? -2.4 : 0],
    shuttle: [s <= 2 ? 0 : s <= 8 ? D.shuttle.wait : s === 9 ? D.shuttle.arch : D.shuttle.cabinet, 0, 0],
    lift: [0, s >= 11 ? -20 : 0, s >= 11 ? D.sled.lift : 0],
    sled: [0, s >= 11 ? D.sled.out : 0, 0],
  };
  return t;
}
const TAU = { shuttle: 0.55, lift: 0.3, sled: 0.3, card: 0.45, bar: 0.4 };
const state = {};
for (const [name, value] of Object.entries(targets(0))) state[name] = value.slice();
let selected = 0, dial = 0, lit = 0;

function follow(cur, want, dt, tau, calm) {
  if (calm) return want.slice();
  const f = 1 - Math.exp(-dt / tau);
  return cur.map((v, i) => { const next = v + (want[i] - v) * f; return Math.abs(want[i] - next) < 0.01 ? want[i] : next; });
}
const same = (a, b) => a.every((v, i) => v === b[i]);

function place(name, offset) {
  const value = offset[0] || offset[1] || offset[2] ? translateAlong(P, offset) : null;
  for (const el of groups[name] ?? []) value ? el.setAttribute("transform", value) : el.removeAttribute("transform");
}

function draw() {
  for (const name of Object.keys(state)) if (name !== "lift" && name !== "shuttle" && name !== "sled") place(name, state[name]);
  place("shuttle", state.shuttle);
  place("crate", state.shuttle.map((v, i) => v + state.lift[i]));
  place("sled", state.sled);
  const out = state.sled[1];
  if (out > 0.3) {
    const plan = { x: D.sled.x, y: D.sled.front, w: D.sled.w, d: out, r: 0.4 };
    shelf.innerHTML = solidSvg(slabOf(plan, D.sled.z, D.sled.h, P, 2, 0.4), { tone: "hi" });
  } else shelf.innerHTML = "";
  needles.forEach((el, i) => el.setAttribute("d", needleAt(D.dials[i][0], D.dials[i][1], 0.06 + dial * (0.3 + i * 0.08))));
  lamps.forEach((el, i) => (i < Math.floor(lit + 1e-6) ? el.setAttribute("data-glow", "") : el.removeAttribute("data-glow")));
}

function select(s, { announce = true } = {}) {
  selected = s;
  items.forEach((el) => (s && el.dataset.st === D.stations[s - 1].id ? el.setAttribute("data-on", "") : el.removeAttribute("data-on")));
  s ? stage.setAttribute("data-focus", "") : stage.removeAttribute("data-focus");
  buttons.forEach((b, i) => (i === s - 1 ? b.setAttribute("data-on", "") : b.removeAttribute("data-on")));
  const text = s ? pad(s - 1) + " · " + D.stations[s - 1].name + " · " + D.stations[s - 1].fact : "12 steps · hover a part";
  if (readout.textContent !== text) readout.textContent = text;
  detail.textContent = s ? DETAILS[s - 1] : "";
  if (announce) {
    stage.setAttribute("aria-valuenow", String(s));
    stage.setAttribute("aria-valuetext", s ? D.stations[s - 1].name + ": " + DETAILS[s - 1] : "At rest");
  }
  run();
}

let frame = 0, last = 0, visible = false, touring = !still.matches, clock = 0, idle = 0;
const STEP = 2.6;
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  const calm = still.matches;
  if (touring) {
    clock += dt;
    const s = clock < 1.4 ? 0 : 1 + (Math.floor((clock - 1.4) / STEP) % n);
    if (s !== selected) select(s, { announce: false });
  }
  const want = targets(selected);
  // The crate comes back onto the shuttle before the shuttle leaves the cabinet, and the bar stays up while the
  // shuttle is past it, so nothing passes through anything when the tour starts again.
  if (want.lift[1] === 0 && Math.abs(state.lift[1]) > 0.5) want.shuttle = state.shuttle.slice();
  if (state.shuttle[0] > 6) want.bar = [0, 0, 27];
  let moving = false;
  for (const name of Object.keys(state)) {
    const next = follow(state[name], want[name], dt, TAU[name] ?? 0.22, calm);
    if (!same(next, state[name])) moving = true;
    state[name] = next;
  }
  const dialWant = selected === 9 ? 1 : 0;
  const litWant = selected >= 10 ? 5 : 0;
  dial = calm ? dialWant : dial + (dialWant - dial) * (1 - Math.exp(-dt / 0.5));
  lit = calm ? litWant : Math.abs(litWant - lit) < 0.02 ? litWant : lit + Math.sign(litWant - lit) * Math.min(Math.abs(litWant - lit), dt * 4);
  if (Math.abs(dial - dialWant) < 0.002) dial = dialWant; else moving = true;
  if (lit !== litWant) moving = true;
  draw();
  frame = visible && (moving || touring) ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
const takeOver = () => { touring = false; clearTimeout(idle); idle = setTimeout(() => { if (!still.matches) { touring = true; clock = 1.4 + (selected ? (selected - 1) * STEP : 0); run(); } }, 3600); };
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);

const stationAt = (event) => {
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const item = hit && hit.closest ? hit.closest(".it") : null;
  const id = item ? item.dataset.st : "";
  return D.stations.findIndex((s) => s.id === id) + 1;
};
stage.addEventListener("pointermove", (event) => { const s = stationAt(event); if (!s) return; takeOver(); if (s !== selected) select(s); });
stage.addEventListener("pointerdown", (event) => { const s = stationAt(event); if (!s) return; takeOver(); select(s); });
stage.addEventListener("keydown", (event) => {
  let to = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") to = selected >= n ? 1 : selected + 1;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") to = selected <= 1 ? n : selected - 1;
  if (event.key === "Home") to = 1;
  if (event.key === "End") to = n;
  if (event.key === "Escape") to = 0;
  if (to === null) return;
  event.preventDefault();
  takeOver();
  select(to);
});
buttons.forEach((button, i) => {
  const pick = () => { takeOver(); select(i + 1); };
  button.addEventListener("pointerenter", pick);
  button.addEventListener("focus", pick);
  button.addEventListener("click", pick);
});
if (still.matches) touring = false;
select(0);
draw();
`;

const css = `
.dp { --dp-ring: #ffffff14; --dp-hover: #ffffff0c; }
.iso[data-theme="light"] .dp, .iso[data-theme="light"].dp { --dp-ring: #00000016; --dp-hover: #0000000a; }
.dp-stage { outline: none; touch-action: pan-y; }
.dp-stage:focus-visible { outline: 1px solid var(--anatomy-muted); outline-offset: 6px; }
.dp-stage[data-focus] .it:not([data-on]):not([data-st=""]) { --anatomy-hi: var(--anatomy-mid); --anatomy-mid: var(--anatomy-lo); }
.dp-stage[data-focus] .it[data-st=""] { --anatomy-mid: var(--anatomy-lo); }
.it[data-on] { --anatomy-hi: var(--anatomy-lit); --anatomy-mid: var(--anatomy-hi); }
.it[data-on] .iso-top { fill: var(--anatomy-lit-top); }
.it[data-on] .iso-shade { fill: var(--anatomy-lit-shade); }
.dp-stage[data-focus] .dp-needle { stroke: var(--anatomy-mid); }
.dp-lens { fill: var(--anatomy-top); stroke: var(--anatomy-lo); stroke-width: .6; transition: fill 240ms var(--anatomy-ease); }
.dp-lens[data-glow] { fill: var(--anatomy-lit); stroke: var(--anatomy-hi); }
.dp-parts { display: flex; flex-wrap: wrap; gap: 6px; }
.dp-part { display: inline-flex; align-items: baseline; gap: 7px; padding: 5px 10px; border: 0; border-radius: 999px; background: transparent; color: var(--anatomy-muted); font: 12.5px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer; box-shadow: inset 0 0 0 1px var(--dp-ring); transition: color 160ms var(--anatomy-ease), background 160ms var(--anatomy-ease); }
.dp-part:hover, .dp-part:focus-visible, .dp-part[data-on] { color: var(--anatomy-strong); background: var(--dp-hover); outline: none; }
.dp-num { font-family: var(--anatomy-mono); font-size: 10px; color: var(--anatomy-muted); }
.dp-detail { min-height: 3.1em; color: var(--anatomy-text); }
@media (max-width: 640px) {
  .dp .iso-plate { padding: 48px 8px 70px; overflow: hidden; }
  .dp-stage .iso-svg { width: 112%; max-width: none; margin-left: -6%; }
  .dp .iso-plate-corner[data-corner="readout"] { bottom: 22px; right: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .dp .iso-plate-corner[data-corner="hint"] { bottom: 0; }
}
`;

const caption =
  "Deploying SetEmailCategory from GitHub. GitHub stores no secrets: a run started by hand and approved for the prod environment swaps its OIDC token for a token of the deployment identity. That identity's keys open only the resource group (Contributor, and an RBAC Administrator grant that can assign just three roles, to service principals) and join-only locks on the platform team's network. The run then checks its inputs, deploys the infrastructure, drops app.zip into the storage container and checks the health endpoint.";

const parts = STATIONS.map((s, i) => `<button type="button" class="dp-part" data-part="${s.id}"><span class="dp-num">${String(i + 1).padStart(2, "0")}</span>${s.name}</button>`).join("");
const corners = `<div class="iso-plate-corners"><span class="iso-plate-corner" data-corner="fig">Fig 2</span><span class="iso-plate-corner" data-corner="title">Deploying from GitHub</span><span class="iso-plate-corner" data-corner="hint">Hover a part or use the arrow keys</span><span class="iso-plate-corner" data-corner="readout" data-readout>12 steps · hover a part</span></div>`;
const stage = `<div class="iso-stage dp-stage" tabindex="0" role="slider" aria-label="Deployment bench: the arrow keys step through the twelve parts of a deployment, Escape returns to rest" aria-valuemin="0" aria-valuemax="${STATIONS.length}" aria-valuenow="0" aria-valuetext="At rest">${svg}</div>`;
const body = `<style>${css}</style><figure class="iso-figure dp"><div class="iso-plate">${corners}${stage}</div><figcaption class="iso-legend"><span class="dp-parts">${parts}</span><span class="dp-detail" data-detail></span><span class="iso-caption">${caption}</span></figcaption></figure>`;

const file = theme === "light" ? "deployment-light.html" : "deployment.html";
writeFileSync(join(HERE, file), k.pageHtml({ title: "Deploying from GitHub", theme, body, script: kitScript() + live, width: 820 }));
console.log("wrote", file, "·", R.items.length, "items ·", R.solids.length, "solids");
