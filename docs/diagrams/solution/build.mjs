// Fig 1: how SetEmailCategory handles a call, drawn as a franking bench. Build: node build.mjs [--light] [--audit]
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { k, G, T, A, kitScript } from "../kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const THEME = process.argv.includes("--light") ? "light" : "dark";
const W = 760;
const H = 460;
const DEG = Math.PI / 180;

// ---------- Stations (facts from infra/, scripts/, README.md and docs/openquestions.md) ----------

const STATIONS = [
  ["s01", "Power Automate flow", "Power Automate flow · POST /api/messages/categories", "A flow calls the function through a Power Platform custom connector with Entra ID OAuth: POST /api/messages/categories with messageId and/or internetMessageId, categories and mode (add, replace or remove). Power Automate waits at most 120 s for a synchronous call."],
  ["s02", "App Service Authentication", "Easy Auth · connector app only, else 401", "App Service Authentication validates the v2.0 token before any code runs: the audience must be the API app and the token must be issued to the connector's client app. Anything else gets 401. Only /api/health is excluded."],
  ["s03", "Function app", "Function app · Flex · up to 40 instances", "Flex Consumption (FC1), Linux, .NET 10 isolated, 512 MB instances. Up to 40 instances, 50 concurrent requests each, and it scales to zero (no always-ready instances). HTTPS only, TLS 1.2, and a 90 s deadline per request."],
  ["s04", "Managed identity", "Managed identity · system-assigned, no secrets", "A system-assigned managed identity reaches storage, Application Insights and Microsoft Graph. There are no keys, connection strings or secrets in Azure or GitHub."],
  ["s05", "App subnet (VNet integration)", "App subnet · all outbound through the VNet", "VNet integration uses an existing subnet in the platform team's shared VNet, in another resource group: delegated to Microsoft.App/environments, /27 or larger, with an NSG (William Buck policy). All of the app's outbound traffic leaves through it. Subnet ID pending (open question N1)."],
  ["s06", "Microsoft Graph + Exchange RBAC", "Graph · Mail.ReadWrite on one mailbox only", "Exchange RBAC for Applications grants Mail.ReadWrite on one shared mailbox and nothing else; the identity has no tenant-wide Graph permission. Graph allows 4 concurrent requests per mailbox, so the function sends at most 4 per instance and retries 429 and 5xx."],
  ["s07", "Shared mailbox", "Shared mailbox · categories set · 200", "The categories are set on the message. If messageId no longer finds it (the message was moved), the function looks it up by internetMessageId. It returns 200 with messageId, categories and changed."],
  ["s08", "Private endpoints (PE subnet)", "Private endpoints · blob and table only", "Two private endpoints, pe-<storage>-blob and pe-<storage>-table, sit in the existing private endpoint subnet (not delegated, NSG attached). There is no queue endpoint: the app has HTTP triggers only."],
  ["s09", "Private DNS", "Private DNS · hub zones, pending N2", "privatelink.blob and privatelink.table resolve the endpoints. The VNet is shared, so the template creates no zones (createPrivateDnsZones = false); the hub zone IDs, or a policy that registers the endpoints, are pending (open question N2)."],
  ["s10", "Storage account", "Storage · public access and shared keys off", "Standard_LRS. Public network access and shared keys are disabled and OAuth is the default. Blob holds the app-package deployment container and the host's leases; table holds diagnostic events. The identity has Storage Blob Data Owner and Storage Table Data Contributor."],
  ["s11", "Application Insights + Log Analytics", "App Insights · Entra-only ingestion · 90 days", "Application Insights accepts only Entra-authenticated ingestion (local auth off; the identity has Monitoring Metrics Publisher) and stores into a Log Analytics workspace (PerGB2018, 90-day retention), along with FunctionAppLogs."],
  ["s12", "Alerts", "Alerts · 500/502, 503 bursts, 400/409/413", "An email action group fires on any 500 or 502 in 15 minutes, more than 10 503s in 15 minutes (Graph throttling beyond retries), and any 400, 409 or 413 in an hour. 404 isn't alerted: deleted messages make it routine."],
];

// ---------- World layout (units are about 1 px; x and y on the bench, z up) ----------

const BENCH = { x: -232, y: -140, w: 434, d: 252, r: 10 };
const BENCH_H = 12;
const FOOT_H = 5;

const WALL = { x: -200, y: -42, w: 350, d: 12, r: 1.2 };
const SOLE = { x: -203, y: -45, w: 356, d: 18, r: 2 };
const WALL_TOP = 48;
const CAP_TOP = 52;
const WALL_FRONT = WALL.y + WALL.d;
const WALL_BACK = WALL.y;

const MB = { x: -198, y: -130, w: 96, d: 52, r: 2 };
const MB_TOP = 118;
const FACE = MB.y + MB.d;
const COLS = [0, 1, 2, 3].map((i) => MB.x + 4 + i * 22 + 9.5);
const ROWS = [[44, 60], [62, 78], [80, 96], [98, 114]];
const GX = COLS[2];
const LETTER = { x: GX - 7, y: FACE + 0.6, w: 14, d: 1, r: 0.3 };
const LETTER_Z = [ROWS[2][0] + 1.5, ROWS[2][0] + 14.5];

const DC = { x: -90, y: -128, w: 146, d: 50, r: 2 };
const DC_TOP = 100;
const DRAWER_COLS = 6;
const DRAWER_ROWS = [[40, 58], [60, 78], [80, 98]];
const PULLED = [[2, 1], [3, 1]];
const PULL_OUT = 9;

const ST = { x: 70, y: -130, w: 96, d: 52, r: 2 };
const ST_TOP = 96;
const ST_SIDE = ST.x + ST.w;
const PE_X = [100, 124];
const PE_PLATE = { x: 90, y: -42, w: 44, d: 12, r: 1.5 };

const RAIL_Y = [24, 57];
const RAIL_X = [-176, 82];
const CR = -146;
const CG = -60;
const CD = 59;
const PLATE_Z = [3, 8];
const DOCK = { x: 84, y: 20, w: 12, d: 46, r: 1.5 };
const RULER = { x: -150, y: 68, w: 200, d: 6, r: 1 };

const ARCH_X = CG;
const PINS_Y = [33, 43, 51];
const HOUSING_TOP = 70;
const PIN_LIFT = 3;

const HOPPER = { x: -228, y: 30, w: 34, d: 44, r: 2 };
const HOPPER_Z = [30, 56];

const REC = { x: 110, y: 50, w: 56, d: 50, r: 3 };
const REC_H = 24;
const ROLL_Y = [58, 92];
const ROLL_Z = 31;
const ROLL_R = 5.5;

const BELL_BASE = { x: 176, y: 22, w: 20, d: 20, r: 2 };
const BELL_AT = [186, 32];
const BELL_Z = 40;

const APP_PLATE = { x: GX - 14, y: WALL_FRONT, w: 28, d: 1.6, r: 0.6 };
const HOSE_Z = 12;
const HOSE_R = 2.2;

// The arm: a rod out of a gland on the wall's back face, reaching the shared mailbox's letter.
const GLAND_O = [GX, WALL_BACK, 34];
const BALL_R = 3;
const ROD_R = 1.6;
const STROKE = 22;
const BALL_FULL = [GX, LETTER.y + LETTER.d + BALL_R, 90];
const ARM_A = G.unit3(G.sub3(BALL_FULL, GLAND_O));
const ARM_L = G.len3(G.sub3(BALL_FULL, GLAND_O));
const ARM = G.frameAlong(GLAND_O, ARM_A);
const GLAND_S = 6;

const P = k.fitProjection(
  [
    ...k.boxCorners(BENCH, -BENCH_H - FOOT_H, 0),
    ...k.boxCorners(MB, 0, MB_TOP + 3),
    ...k.boxCorners(ST, 0, ST_TOP + 3),
    [ARCH_X, PINS_Y[0], HOUSING_TOP + 8],
  ],
  W,
  H,
  { pad: 30, azimuth: 40 },
);
const V = G.viewOf(P);
const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const Dots = (points, style) => k.dotsSvg(points, style);
const path = (points, closed = false) => k.pathOf(points.map(at), closed);
// Closed outlines on vertical faces: a rounded rectangle in (along, z) on the plane y = c or x = c.
const onY = (y, x0, z0, x1, z1, r = 0.8) => path(k.roundedPlan({ x: x0, y: z0, w: x1 - x0, d: z1 - z0, r }, 3).map(([x, z]) => [x, y, z]), true);
const onX = (x, y0, z0, y1, z1, r = 0.8) => path(k.roundedPlan({ x: y0, y: z0, w: y1 - y0, d: z1 - z0, r }, 3).map(([y, z]) => [x, y, z]), true);

// ---------- Recorder: every item with its true shape, settled by measured depth ----------

const RIDES = ["carriage", "pins", "rod", "pen", "striker"];
const SPRING = { stagger: 0.035, stiffness: 64, damping: 14.2, substeps: 4 };
const STRIKE_DIR = G.unit3([-Math.cos(40 * DEG), -Math.sin(40 * DEG), 0]);
const MOVES = {
  carriage: [CD - CR, 0, 0],
  pins: [0, 0, PIN_LIFT],
  rod: G.mul3(ARM_A, STROKE),
  pen: [-10, 0, 0],
  striker: G.mul3(STRIKE_DIR, 1.5),
};
const R = A.recorder(P, { order: RIDES, spring: SPRING });

function put(piece, ref, svg, { ride, bias = 0, shapes = [], name, route, chunk } = {}) {
  R.put({ piece, ride: ride ?? piece, at: ref, bias, svg, move: ride ? MOVES[ride] : [0, 0, 0], shapes, name: name ?? R.nameFor(`${piece}.item`), route, chunk });
}

function box(piece, plan, z, h, style = {}, { steps = 4, bevel = 0.5, extra = "", inner = "", ride, bias = 0, name, owner } = {}) {
  const id = R.nameFor(name ?? `${piece}.box`);
  const shape = R.solid(A.slab(plan, z, h, { name: id, owner }, steps));
  put(piece, [plan.x + plan.w / 2, plan.y + plan.d / 2, z + h / 2], S(k.slabOf(plan, z, h, P, steps, bevel), { tone: "mid", ...style, inner }) + extra, { ride, bias, shapes: [shape], name: id });
  return shape;
}

function cyl(piece, cx, cy, r, z, h, style = {}, { steps = 24, bevel = 0, extra = "", inner = "", ride, bias = 0, name, owner } = {}) {
  const id = R.nameFor(name ?? `${piece}.cyl`);
  const shape = R.solid(A.cylinder(cx, cy, r, z, h, { name: id, owner }));
  put(piece, [cx, cy, z + h / 2], S(k.cylinder(cx, cy, r, z, h, P, steps, bevel), { tone: "mid", ...style, inner }) + extra, { ride, bias, shapes: [shape], name: id });
  return shape;
}

function disc(piece, F, s0, s1, r, style = {}, { extra = "", inner = "", ride, bias = 0, name, owner } = {}) {
  const id = R.nameFor(name ?? `${piece}.disc`);
  const shape = R.solid(A.disc(F, s0, s1, r, { name: id, owner }));
  put(piece, G.add3(F.o, G.mul3(F.a, (s0 + s1) / 2)), S(G.disc(s0, s1, r, F, P), { tone: "mid", ...style, inner }) + extra, { ride, bias, shapes: [shape], name: id });
  return shape;
}

function prism(piece, F, polygon, s0, s1, style = {}, { extra = "", ride, bias = 0, name, owner } = {}) {
  const id = R.nameFor(name ?? `${piece}.prism`);
  const shape = R.solid(A.prism(F, polygon, s0, s1, { name: id, owner }));
  put(piece, G.add3(F.o, G.mul3(F.a, (s0 + s1) / 2)), S(G.prismOf(F, polygon, s0, s1, P), { tone: "mid", ...style }) + extra, { ride, bias, shapes: [shape], name: id });
}

const ROUTES = [];
// A pipe or cable between two real faces. Ferrules (hose) or terminal dots (cables) land each end.
function line(piece, control, r, { name, tone = "hi", ferrule = 0, maxLength = 20, bend = 2.6 } = {}) {
  const route = G.fillet(control, Math.max(r * bend, 3), 10, { P, tube: r });
  const total = G.pathLength(route);
  const id = R.nameFor(name);
  const gaps = ferrule ? [[0, ferrule], [total - ferrule, total]] : [];
  R.route(id, route, r, { piece, owner: id, limp: !ferrule, gaps });
  const pieces = T.tubePieces(route, r, P, { maxLength, gaps });
  pieces.forEach((part, index) => {
    const ends = ferrule ? "" : [index === 0 ? route[0] : null, index === pieces.length - 1 ? route[route.length - 1] : null].filter(Boolean);
    const dots = ends.length ? Dots(ends.map(at), { size: r * 0.9, tone: "mid" }) : "";
    put(piece, part.mid, T.tubeSvg(part, { tone }) + dots, { name: `${id}:${index}`, route: id, chunk: index, shapes: [A.tube(part.points, part.radii)] });
  });
  if (ferrule) {
    [[0, 1], [total, -1]].forEach(([along, sign]) => {
      const tangent = G.mul3(G.tangentAlong(route, along), sign);
      disc(piece, G.frameAlong(G.pointAlong(route, along), tangent), 0, ferrule, r * 1.45, { tone: "mid" }, { name: `${id}.ferrule`, owner: id });
    });
  }
  ROUTES.push(id);
  return id;
}

const corners = (plan, inset) => k.corners(plan, inset);
const screws = (plan, z, inset = 3, size = 0.45) => Dots(corners(plan, inset).map(([x, y]) => at([x, y, z])), { size });

// ---------- Bench ----------

const HALO = `<path class="iso-halo" d="${k.haloOf(BENCH, -BENCH_H - FOOT_H, BENCH_H, P)}"/>`;
for (const [x, y] of corners(BENCH, 24)) {
  cyl("bench", x, y, 7, -BENCH_H - FOOT_H, 1.6, { tone: "lo" }, { name: "stand.foot-flange" });
  cyl("bench", x, y, 5.4, -BENCH_H - FOOT_H + 1.6, FOOT_H - 1.6, { tone: "mid" }, { name: "stand.foot" });
}
{
  const groove = L(k.planOutline(k.insetPlan(BENCH, 5), 0, P, 8), { tone: "lo" });
  const rings = L(corners(BENCH, 11).map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" });
  box("bench", BENCH, -BENCH_H, BENCH_H, { tone: "mid" }, { steps: 8, bevel: 1.6, extra: groove + rings + screws(BENCH, 0, 11, 0.5), name: "stand.bench", bias: -100 });
}
// Label plate: three rule lines stand for printed text.
{
  const plan = { x: -206, y: 90, w: 46, d: 14, r: 1.2 };
  const rules = [[0.82, 0], [0.6, 4], [0.7, 8]].map(([share, dy]) => k.lineOnTop([plan.x + 5, plan.y + 3.2 + dy], [plan.x + 5 + (plan.w - 10) * share, plan.y + 3.2 + dy], 0.8, P)).join("");
  box("bench", plan, 0, 0.8, { tone: "lo", crease: "none" }, { steps: 3, bevel: 0, extra: L(k.planOutline(k.insetPlan(plan, 1.6), 0.8, P, 3), { tone: "faint" }) + L(rules, { tone: "lo", free: true }) + Dots([at([plan.x + 2.6, plan.y + plan.d / 2, 0.8]), at([plan.x + plan.w - 2.6, plan.y + plan.d / 2, 0.8])], { size: 0.4 }), name: "stand.label" });
}

// ---------- Wall: the platform's shared VNet ----------

box("bench", SOLE, 0, 3, { tone: "lo" }, { steps: 3, bevel: 0.4, name: "stand.wall-sole", owner: "wall" });
{
  const studs = [-170, -110, -50, 10, 70, 130].filter((x) => Math.abs(x - GX) > 18).map((x) => k.segment([x, WALL_FRONT, 3], [x, WALL_FRONT, WALL_TOP], P)).join("");
  const seam = k.sideSeam(WALL, 26, P, 2);
  box("bench", WALL, 3, WALL_TOP - 3, { tone: "mid" }, { steps: 2, bevel: 0, inner: L(seam, { tone: "faint" }), extra: L(studs, { tone: "faint" }), name: "stand.wall", owner: "wall" });
}
{
  const cap = { ...SOLE };
  const bolts = [];
  for (let x = -195; x <= 145; x += 20) bolts.push(at([x, SOLE.y + 3.2, CAP_TOP]), at([x, SOLE.y + SOLE.d - 3.2, CAP_TOP]));
  box("bench", cap, WALL_TOP, CAP_TOP - WALL_TOP, { tone: "mid" }, { steps: 3, bevel: 0.6, extra: Dots(bolts, { size: 0.4, tone: "lo" }), name: "stand.wall-cap", owner: "wall" });
}

// App subnet plate (station 05): grille slots for the NSG, a boss where the hose lands.
{
  const slots = [0, 1, 2, 3, 4, 5].map((i) => onY(APP_PLATE.y + APP_PLATE.d, GX - 10.5 + i * 4.2, 22, GX - 8.9 + i * 4.2, 37, 0.8)).join("");
  const frame = onY(APP_PLATE.y + APP_PLATE.d, GX - 12, 20, GX + 12, 39, 1.2);
  const plateScrews = Dots([[GX - 12, 8], [GX + 12, 8], [GX - 12, 40], [GX + 12, 40]].map(([x, z]) => at([x, APP_PLATE.y + APP_PLATE.d, z])), { size: 0.42 });
  box("s05", APP_PLATE, 6, 36, { tone: "hi" }, { steps: 2, bevel: 0, extra: L(slots, { tone: "lo" }) + L(frame, { tone: "faint" }) + plateScrews, name: "s05.plate", owner: "wall" });
  const F = G.frameOf([GX, APP_PLATE.y + APP_PLATE.d, HOSE_Z], [0, 1, 0], [1, 0, 0], [0, 0, 1]);
  disc("s05", F, 0, 4, 4.4, { tone: "hi" }, { extra: L(G.circleOf(F, 4, 2.6, P, 24), { tone: "faint" }), name: "s05.boss", owner: "wall" });
}
// Gland on the wall's back face where the arm leaves the VNet.
disc("s05", ARM, 0, GLAND_S, 4.2, { tone: "hi" }, { extra: L(G.circleOf(ARM, GLAND_S, ROD_R + 0.5, P, 20), { tone: "faint" }), name: "s05.gland", owner: "wall" });

// PE subnet plate (station 08) on the cap, with its grille and two sockets.
{
  const z = CAP_TOP;
  const slots = [0, 1, 2, 3].map((i) => k.planOutline({ x: PE_PLATE.x + 30 + i * 3.2, y: PE_PLATE.y + 2.5, w: 1.4, d: 7, r: 0.7 }, z + 1.2, P, 3)).join("");
  box("s08", PE_PLATE, z, 1.2, { tone: "hi" }, { steps: 3, bevel: 0.3, extra: L(slots, { tone: "lo" }) + screws(PE_PLATE, z + 1.2, 2.2, 0.4), name: "s08.plate", owner: "wall" });
  for (const x of PE_X) cyl("s08", x, -36, 3, z + 1.2, 4, { tone: "hi" }, { extra: L(k.ring(x, -36, 1.6, z + 5.2, P, 16), { tone: "faint" }), name: "s08.socket", owner: "wall" });
}

// ---------- Mailbox cabinet (stations 06 and 07) ----------

box("s07", { x: MB.x + 2, y: MB.y + 2, w: MB.w - 4, d: MB.d - 4, r: 1.5 }, 0, 4, { tone: "lo" }, { steps: 3, name: "s07.plinth" });
{
  const cells = [];
  const voids = [];
  for (const [z0, z1] of ROWS) for (const x of COLS) {
    cells.push(onY(FACE, x - 9.5, z0 + 1.5, x + 9.5, z1, 1));
    voids.push(onY(FACE, x - 9.5, z0 + 1.5, x + 9.5, z1, 1));
  }
  const seam = k.sideSeam(MB, ROWS[0][0] - 4, P, 3);
  const extra = `<path class="iso-shade" data-shade="0" d="${voids.join("")}"/>` + L(cells.join(""), { tone: "lo" });
  const side = L(onX(MB.x + MB.w, MB.y + 6, 50, MB.y + MB.d - 6, 110, 1.5) + onX(MB.x + MB.w, MB.y + 16, 96, MB.y + MB.d - 16, 104, 0.6), { tone: "faint" });
  box("s07", MB, 4, MB_TOP - 4, { tone: "mid" }, { steps: 3, bevel: 0, inner: L(seam, { tone: "faint" }), extra: extra + side, name: "s07.cabinet" });
}
box("s07", { x: MB.x - 2, y: MB.y - 2, w: MB.w + 4, d: MB.d + 4, r: 2.5 }, MB_TOP, 3, { tone: "mid" }, { steps: 3, bevel: 0.6, extra: screws({ x: MB.x - 2, y: MB.y - 2, w: MB.w + 4, d: MB.d + 4 }, MB_TOP + 3, 4) + L(k.planOutline(k.insetPlan(MB, 5), MB_TOP + 3, P, 3), { tone: "faint" }), name: "s07.top" });
ROWS.forEach(([z0], index) => box("s07", { x: MB.x + 2, y: FACE, w: MB.w - 4, d: 3, r: 0.6 }, z0, 1.5, { tone: "mid" }, { steps: 2, bevel: 0, name: `s07.sill${index}` }));
// Other mailboxes' letters, dim; the shared mailbox's letter is the subject.
for (const [col, row, h] of [[0, 0, 12], [1, 1, 10], [3, 1, 13], [0, 3, 11], [3, 3, 12], [1, 3, 9]]) {
  const x = COLS[col];
  box("s07", { x: x - 6, y: FACE + 0.6, w: 12, d: 1, r: 0.3 }, ROWS[row][0] + 1.5, h, { tone: "lo" }, { steps: 2, bevel: 0, name: "s07.other-letter" });
}
{
  const face = LETTER.y + LETTER.d;
  const marks = [[-4.5, "orange"], [1.5, "blue"]].map(([dx, c]) => `<path class="sc-ink sc-mark" data-c="${c}" d="${onY(face, GX + dx, 86.5, GX + dx + 3.6, 90.1, 0.5)}"/>`).join("");
  const address = L([[-5, 92.2, 0.7], [-5, 84, 0.55]].map(([dx, z, share]) => path([[GX + dx, face, z], [GX + dx + 10 * share, face, z]])).join(""), { tone: "lo", free: true });
  box("s07", LETTER, LETTER_Z[0], LETTER_Z[1] - LETTER_Z[0], { tone: "hi" }, { steps: 2, bevel: 0, extra: address + marks, name: "s07.letter" });
}

// The arm (station 06): one rod out of the gland, a stop collar that limits its reach, and a ball stamp.
{
  const ballS = ARM_L - STROKE;
  const rodTo = ballS - Math.sqrt(BALL_R ** 2 - ROD_R ** 2);
  const collarS = GLAND_S + STROKE;
  const ROD = G.rodOut(ARM, GLAND_S, collarS, ROD_R, P, { stroke: STROKE });
  const svg = `<clipPath id="sc-rod"><path data-hold d="${ROD.clip}"/></clipPath><g clip-path="url(#sc-rod)">${S(ROD.paths, { tone: "hi" })}</g>`;
  put("s06", G.add3(GLAND_O, G.mul3(ARM_A, (GLAND_S + collarS) / 2)), svg, { ride: "rod", name: "s06.rod", shapes: [R.solid(A.slide(ARM, GLAND_S, collarS, ROD_R, { name: "s06.rod", owner: "arm" }))] });
  disc("s06", ARM, collarS, collarS + 3.5, 3, { tone: "hi" }, { ride: "rod", extra: Dots(G.dotsOf(ARM, collarS + 3.5, 2.3, 1, P, { all: true }), { size: 0.4 }), name: "s06.collar", owner: "arm" });
  disc("s06", ARM, collarS + 3.5, rodTo, ROD_R, { tone: "hi" }, { ride: "rod", name: "s06.reach", owner: "arm" });
  const centre = G.add3(GLAND_O, G.mul3(ARM_A, ballS));
  const id = R.nameFor("s06.ball");
  put("s06", centre, S(G.sphereOf(centre, BALL_R, P), { tone: "hi" }), { ride: "rod", name: id, shapes: [R.solid(A.ball(centre, BALL_R, { name: id, owner: "arm" }))] });
}

// ---------- DNS card catalogue (station 09) ----------

box("s09", { x: DC.x + 2, y: DC.y + 2, w: DC.w - 4, d: DC.d - 4, r: 1.5 }, 0, 4, { tone: "lo" }, { steps: 3, name: "s09.plinth" });
const DC_FACE = DC.y + DC.d;
const DRAWER_W = (DC.w - 8 - (DRAWER_COLS - 1) * 2) / DRAWER_COLS;
const drawerX = (col) => DC.x + 4 + col * (DRAWER_W + 2);
box("s09", DC, 4, DC_TOP - 4, { tone: "mid" }, { steps: 3, bevel: 0, inner: L(k.sideSeam(DC, 30, P, 3), { tone: "faint" }), name: "s09.cabinet" });
box("s09", { x: DC.x - 2, y: DC.y - 2, w: DC.w + 4, d: DC.d + 4, r: 2.5 }, DC_TOP, 3, { tone: "mid" }, { steps: 3, bevel: 0.6, extra: screws({ x: DC.x - 2, y: DC.y - 2, w: DC.w + 4, d: DC.d + 4 }, DC_TOP + 3, 4) + L(k.planOutline(k.insetPlan(DC, 5), DC_TOP + 3, P, 3), { tone: "faint" }), name: "s09.top" });
DRAWER_ROWS.forEach(([z0, z1], row) => {
  for (let col = 0; col < DRAWER_COLS; col += 1) {
    const pulled = PULLED.some(([c, r]) => c === col && r === row);
    const x0 = drawerX(col);
    const out = pulled ? PULL_OUT : 0;
    const front = DC_FACE + out;
    const plan = { x: x0, y: DC_FACE, w: DRAWER_W, d: 1.4 + out, r: 0.6 };
    const mid = x0 + DRAWER_W / 2;
    const holder = onY(front + 1.4, mid - 5, z1 - 6.5, mid + 5, z1 - 2.5, 0.6);
    const pull = onY(front + 1.4, mid - 3.5, z0 + 5, mid + 3.5, z0 + 7, 1);
    const cards = pulled ? L([0.25, 0.5, 0.75].map((t) => k.lineOnTop([x0, DC_FACE + 1.4 + out * t], [x0 + DRAWER_W, DC_FACE + 1.4 + out * t], z1, P)).join(""), { tone: pulled ? "mid" : "lo" }) : "";
    box(pulled ? "s09" : "s09-frame", plan, z0, z1 - z0, { tone: pulled ? "hi" : "mid" }, { steps: 2, bevel: 0, extra: L(holder + pull, { tone: "lo" }) + cards, name: pulled ? "s09.zone-drawer" : "s09.drawer" });
  }
});

// ---------- Storage cabinet (station 10), fed only by the private endpoint cables ----------

box("s10", { x: ST.x + 2, y: ST.y + 2, w: ST.w - 4, d: ST.d - 4, r: 1.5 }, 0, 4, { tone: "lo" }, { steps: 3, name: "s10.plinth" });
const ST_FACE = ST.y + ST.d;
box("s10", ST, 4, ST_TOP - 4, { tone: "mid" }, { steps: 3, bevel: 0, inner: L(k.sideSeam(ST, 49, P, 3), { tone: "faint" }), name: "s10.cabinet" });
box("s10", { x: ST.x - 2, y: ST.y - 2, w: ST.w + 4, d: ST.d + 4, r: 2.5 }, ST_TOP, 3, { tone: "mid" }, { steps: 3, bevel: 0.6, extra: screws({ x: ST.x - 2, y: ST.y - 2, w: ST.w + 4, d: ST.d + 4 }, ST_TOP + 3, 4) + L(k.planOutline(k.insetPlan(ST, 5), ST_TOP + 3, P, 3), { tone: "faint" }), name: "s10.top" });
// Blanked front: no door, only the two endpoint sockets.
const BLANK = { x: ST.x + 6, y: ST_FACE, w: ST.w - 12, d: 1.2, r: 0.5 };
{
  const face = ST_FACE + 1.2;
  const bolts = [];
  for (const x of [BLANK.x + 3, BLANK.x + BLANK.w / 2, BLANK.x + BLANK.w - 3]) for (const z of [48, 90]) bolts.push(at([x, face, z]));
  box("s10", BLANK, 45, 48, { tone: "mid" }, { steps: 2, bevel: 0, extra: Dots(bolts, { size: 0.45 }) + L(onY(face, BLANK.x + 6, 50, BLANK.x + BLANK.w - 6, 88, 1.5), { tone: "faint" }), name: "s10.blank" });
}
const ST_SOCKET_Z = 70;
for (const x of PE_X) {
  const F = G.frameOf([x, ST_FACE + 1.2, ST_SOCKET_Z], [0, 1, 0], [1, 0, 0], [0, 0, 1]);
  disc("s08", F, 0, 4, 3.4, { tone: "hi" }, { extra: L(G.circleOf(F, 4, 1.8, P, 20), { tone: "faint" }), name: "s08.inlet" });
}
// Two drawers on the side face: blob (app-package, leases) above, table (diagnostic events) below.
for (const [z0, z1] of [[52, 88], [12, 46]]) {
  const plan = { x: ST_SIDE, y: ST.y + 6, w: 1.6, d: ST.d - 12, r: 0.6 };
  const face = ST_SIDE + 1.6;
  const ym = plan.y + plan.d / 2;
  const holder = onX(face, ym - 8, z1 - 9, ym + 8, z1 - 3, 0.6);
  const card = onX(face, ym - 6.5, z1 - 8, ym + 6.5, z1 - 4, 0.4);
  box("s10", plan, z0, z1 - z0, { tone: "hi" }, { steps: 2, bevel: 0, extra: L(holder, { tone: "lo" }) + L(card, { tone: "faint" }) + Dots([at([face, plan.y + 2.5, z0 + 2.5]), at([face, plan.y + plan.d - 2.5, z0 + 2.5]), at([face, plan.y + 2.5, z1 - 2.5]), at([face, plan.y + plan.d - 2.5, z1 - 2.5])], { size: 0.4 }), name: "s10.drawer" });
  const zp = z0 + (z1 - z0) * 0.42;
  for (const y of [ym - 7, ym + 5]) box("s10", { x: face, y, w: 3, d: 2, r: 0.4 }, zp - 1, 2, { tone: "mid" }, { steps: 2, bevel: 0, name: "s10.pull-post" });
  box("s10", { x: face + 3, y: ym - 8, w: 1.6, d: 16, r: 0.6 }, zp - 1.2, 2.4, { tone: "hi" }, { steps: 2, bevel: 0, name: "s10.pull" });
}
// Private endpoint cables (station 08): from the PE sockets over to the cabinet's inlets.
PE_X.forEach((x, index) => line("s08", [[x, -36, CAP_TOP + 5.2], [x, -36, ST_SOCKET_Z], [x, ST_FACE + 5.2, ST_SOCKET_Z]], 1.3, { name: `s08.cable-${index ? "table" : "blob"}`, tone: "hi" }));

// ---------- Rails, dock and the instance ruler (station 03) ----------

for (const y of RAIL_Y) box("s03", { x: RAIL_X[0], y, w: RAIL_X[1] - RAIL_X[0], d: 5, r: 1 }, 0, 3, { tone: "mid" }, { steps: 3, bevel: 0.4, extra: Dots([RAIL_X[0] + 6, RAIL_X[1] - 6].map((x) => at([x, y + 2.5, 3])), { size: 0.4 }), name: "s03.rail" });
box("s03", { x: RAIL_X[0] - 6, y: 21, w: 5, d: 44, r: 1.2 }, 0, 8, { tone: "mid" }, { steps: 3, bevel: 0.5, extra: Dots([at([RAIL_X[0] - 3.5, 26, 8]), at([RAIL_X[0] - 3.5, 60, 8])], { size: 0.45 }), name: "s03.stop" });
box("s03", DOCK, 0, 16, { tone: "mid" }, { steps: 3, bevel: 0.6, extra: screws(DOCK, 16, 2.6) + L(k.planOutline(k.insetPlan(DOCK, 2.2), 16, P, 3), { tone: "faint" }), name: "s03.dock" });
{
  const ticks = k.topTicks(RULER.x + 2.5, RULER.x + RULER.w - 2.5, 5, 5, RULER.y + 0.8, 0.6, [2, 3.6], P);
  box("s03", RULER, 0, 0.6, { tone: "lo", crease: "none" }, { steps: 3, bevel: 0, extra: L(ticks.minor, { tone: "lo" }) + L(ticks.major, { tone: "mid" }) + Dots([at([RULER.x + 1.2, RULER.y + 3, 0.6]), at([RULER.x + RULER.w - 1.2, RULER.y + 3, 0.6])], { size: 0.4 }), name: "s03.ruler" });
}

// ---------- Carriage (station 03) with the badge (04) and the request card (01) ----------

const CP = { x: CR - 25, y: 20, w: 50, d: 46, r: 3 };
{
  const rivets = Dots([-19, -9, 1, 11].map((dx) => at([CR + dx, CP.y + CP.d - 2.2, PLATE_Z[1]])), { size: 0.4, tone: "lo" });
  box("s03", CP, PLATE_Z[0], PLATE_Z[1] - PLATE_Z[0], { tone: "mid" }, { steps: 5, bevel: 0.6, ride: "carriage", extra: rivets, name: "s03.carriage" });
}
for (const [dx, y] of [[-24, 23], [17, 23], [-24, 56], [17, 56]]) box("s03", { x: CR + dx, y, w: 7, d: 7, r: 1 }, PLATE_Z[1], 3, { tone: "mid" }, { steps: 2, bevel: 0.4, ride: "carriage", extra: Dots([at([CR + dx + 3.5, y + 3.5, PLATE_Z[1] + 3])], { size: 0.42 }), name: "s03.bushing" });
const TURRET = [CR + 6, 37];
cyl("s03", TURRET[0], TURRET[1], 10, PLATE_Z[1], 4, { tone: "hi", crease: "lo" }, { steps: 48, bevel: 0.5, ride: "carriage", extra: L(k.ring(TURRET[0], TURRET[1], 8.2, PLATE_Z[1] + 4, P, 40), { tone: "faint" }), name: "s03.turret" });
const HUB_TOP = PLATE_Z[1] + 4 + 9;
cyl("s03", TURRET[0], TURRET[1], 3.6, PLATE_Z[1] + 4, 9, { tone: "mid" }, { steps: 20, ride: "carriage", extra: L(k.knurl(TURRET[0], TURRET[1], 3.6, HUB_TOP - 3, HUB_TOP, 16, P), { tone: "lo" }), name: "s03.hub" });
const CATS = ["red", "orange", "yellow", "green", "blue", "purple"];
CATS.forEach((c, index) => {
  const a = (index * 60 + 15) * DEG;
  const x = TURRET[0] + Math.cos(a) * 6.6;
  const y = TURRET[1] + Math.sin(a) * 6.6;
  const top = PLATE_Z[1] + 4 + 6.5;
  cyl("s03", x, y, 2.2, PLATE_Z[1] + 4, 6.5, { tone: "mid" }, { steps: 16, ride: "carriage", extra: `<path class="sc-ink" data-c="${c}" d="${k.ring(x, y, 1.7, top, P, 16)}Z"/>`, name: "s03.stamp" });
});
{
  const plan = { x: CR + 2, y: 50, w: 13, d: 9, r: 1 };
  const hole = L(k.ring(plan.x + 3, plan.y + 4.5, 1, PLATE_Z[1] + 1, P, 12), { tone: "lo" });
  const rules = L([0.7, 0.5].map((share, i) => k.lineOnTop([plan.x + 5.5, plan.y + 3 + i * 3], [plan.x + 5.5 + 6 * share, plan.y + 3 + i * 3], PLATE_Z[1] + 1, P)).join(""), { tone: "lo", free: true });
  box("s04", plan, PLATE_Z[1], 1, { tone: "hi" }, { steps: 3, bevel: 0.3, ride: "carriage", extra: hole + rules, name: "s04.badge" });
  box("s04", { x: plan.x + 1.5, y: plan.y + 3, w: 3, d: 3, r: 0.5 }, PLATE_Z[1] + 1, 1.2, { tone: "mid" }, { steps: 2, bevel: 0, ride: "carriage", name: "s04.clip" });
}
const CARD = { x: CR - 16, y: 46, w: 16, d: 16, r: 0.8 };
{
  const top = PLATE_Z[1] + 1.2;
  const punched = Dots([0, 1, 2, 3].map((i) => at([CARD.x + 2.5 + i * 3, CARD.y + 3, top])), { size: 0.55, tone: "hi" });
  const rules = L([[0.9, 7.5], [0.65, 10.5], [0.75, 13.5]].map(([share, dy]) => k.lineOnTop([CARD.x + 3, CARD.y + dy], [CARD.x + 2.5 + 11 * share, CARD.y + dy], top, P)).join(""), { tone: "lo", free: true });
  box("s01", CARD, PLATE_Z[1], 1.2, { tone: "hi" }, { steps: 2, bevel: 0.3, ride: "carriage", extra: punched + rules, name: "s01.card" });
}

// ---------- Gate arch (station 02) ----------

const POSTS = [{ x: ARCH_X - 8, y: -2, w: 16, d: 8, r: 1.2 }, { x: ARCH_X - 8, y: 78, w: 16, d: 8, r: 1.2 }];
for (const plan of POSTS) box("s02", plan, 0, 50, { tone: "mid" }, { steps: 3, bevel: 0.5, inner: L(k.sideSeam(plan, 6, P, 3), { tone: "faint" }), name: "s02.post" });
const LINTEL = { x: ARCH_X - 10, y: -4, w: 20, d: 92, r: 1.6 };
box("s02", LINTEL, 50, 8, { tone: "mid" }, { steps: 3, bevel: 0.6, extra: Dots([0, 1].flatMap((i) => [at([ARCH_X - 6 + i * 12, LINTEL.y + 4, 58]), at([ARCH_X - 6 + i * 12, LINTEL.y + LINTEL.d - 4, 58])]), { size: 0.45 }), name: "s02.lintel" });
const HOUSING = { x: ARCH_X - 8, y: 27, w: 16, d: 32, r: 1.6 };
box("s02", HOUSING, 58, HOUSING_TOP - 58, { tone: "hi", crease: "lo" }, { steps: 3, bevel: 0.6, inner: L(k.sideSeam(HOUSING, 64, P, 3), { tone: "faint" }), extra: L(PINS_Y.map((y) => k.ring(ARCH_X, y, 2.6, HOUSING_TOP, P, 16)).join(""), { tone: "lo" }), name: "s02.housing" });
cyl("s02", ARCH_X, 54, 2.4, 16, 34, { tone: "mid", crease: "none" }, { steps: 16, extra: L(k.sideArc(ARCH_X, 54, 2.4, 20, P, 12), { tone: "faint" }), name: "s02.head" });
for (const y of PINS_Y) {
  cyl("s02", ARCH_X, y, 1.6, HOUSING_TOP, 4, { tone: "hi" }, { steps: 14, ride: "pins", name: "s02.pin" });
  cyl("s02", ARCH_X, y, 2.2, HOUSING_TOP + 4, 1.2, { tone: "hi" }, { steps: 16, ride: "pins", name: "s02.pin-cap" });
}
// Reject tray for 401s, with a refused card in it.
{
  const TRAY = { x: ARCH_X - 14, y: 90, w: 28, d: 18, r: 1.5 };
  box("s02", TRAY, 0, 1.5, { tone: "lo" }, { steps: 3, bevel: 0.3, name: "s02.tray" });
  for (const plan of [{ x: TRAY.x, y: TRAY.y, w: TRAY.w, d: 1.2, r: 0.4 }, { x: TRAY.x, y: TRAY.y + TRAY.d - 1.2, w: TRAY.w, d: 1.2, r: 0.4 }, { x: TRAY.x, y: TRAY.y + 1.2, w: 1.2, d: TRAY.d - 2.4, r: 0.4 }, { x: TRAY.x + TRAY.w - 1.2, y: TRAY.y + 1.2, w: 1.2, d: TRAY.d - 2.4, r: 0.4 }])
    box("s02", plan, 1.5, 4, { tone: "mid" }, { steps: 2, bevel: 0, name: "s02.tray-lip" });
  const refused = { x: TRAY.x + 5, y: TRAY.y + 3.5, w: 16, d: 11, r: 0.6 };
  box("s02", refused, 1.5, 0.8, { tone: "lo" }, { steps: 2, bevel: 0, extra: L(k.lineOnTop([refused.x + 2.5, refused.y + 5], [refused.x + 12, refused.y + 5], 2.3, P), { tone: "faint", free: true }), name: "s02.refused" });
}

// ---------- Hopper and chute (station 01) ----------

for (const [x, y] of corners(HOPPER, 4)) cyl("s01", x, y, 1.8, 0, HOPPER_Z[0], { tone: "mid", crease: "none" }, { steps: 14, extra: L(k.sideArc(x, y, 1.8, 10, P, 10), { tone: "faint" }), name: "s01.post" });
box("s01", HOPPER, HOPPER_Z[0], HOPPER_Z[1] - HOPPER_Z[0], { tone: "mid" }, { steps: 3, bevel: 0.6, inner: L(k.sideSeam(HOPPER, 37, P, 3), { tone: "faint" }), extra: L(k.planOutline(k.insetPlan(HOPPER, 3), HOPPER_Z[1], P, 3), { tone: "faint" }), name: "s01.hopper", owner: "hopper" });
[0, 1, 2].forEach((i) => box("s01", { x: HOPPER.x + 4 + i * 0.8, y: HOPPER.y + 6 - i * 0.6, w: 24, d: 30, r: 0.8 }, HOPPER_Z[1] + i, 1, { tone: i === 2 ? "hi" : "mid" }, { steps: 2, bevel: 0, extra: i === 2 ? Dots([0, 1, 2, 3].map((j) => at([HOPPER.x + 8 + i * 0.8 + j * 3.2, HOPPER.y + 9 - i * 0.6, HOPPER_Z[1] + 3])), { size: 0.5 }) : "", name: "s01.queued" }));
{
  const start = [HOPPER.x + HOPPER.w, (HOPPER.y + HOPPER.y + HOPPER.d) / 2, HOPPER_Z[0] + 3];
  const a = G.unit3([36, 0, -16]);
  const F = G.frameOf(start, a, [0, 1, 0], G.unit3(G.cross3(a, [0, 1, 0])));
  const length = (CARD.x + 4 - start[0]) / a[0];
  prism("s01", F, [[-10, -0.8], [10, -0.8], [10, 0.8], [-10, 0.8]], 0, length, { tone: "hi" }, { name: "s01.chute", owner: "hopper" });
  for (const side of [-1, 1]) prism("s01", F, side < 0 ? [[-11.2, -0.8], [-10, -0.8], [-10, 3.2], [-11.2, 3.2]] : [[10, -0.8], [11.2, -0.8], [11.2, 3.2], [10, 3.2]], 0, length, { tone: "mid" }, { name: "s01.chute-lip", owner: "hopper" });
}

// ---------- Outbound hose (station 05) and telemetry (11) ----------

line("s05", [[DOCK.x + DOCK.w / 2, DOCK.y, HOSE_Z], [DOCK.x + DOCK.w / 2, -12, HOSE_Z], [GX, -12, HOSE_Z], [GX, APP_PLATE.y + APP_PLATE.d + 4, HOSE_Z]], HOSE_R, { name: "s05.hose", ferrule: 2.5, maxLength: 16 });
line("s11", [[DOCK.x + DOCK.w / 2, DOCK.y + DOCK.d, 8], [DOCK.x + DOCK.w / 2, 78, 8], [REC.x, 78, 8]], 0.8, { name: "s11.cable", tone: "mid" });

// ---------- Chart recorder (station 11) ----------

{
  const panel = onY(REC.y + REC.d, REC.x + 6, 5, REC.x + REC.w - 6, 19, 1.5);
  const vents = [0, 1, 2, 3, 4].map((i) => onX(REC.x + REC.w, REC.y + 12 + i * 5, 8, REC.y + 13.6 + i * 5, 18, 0.8)).join("");
  box("s11", REC, 0, REC_H, { tone: "mid" }, { steps: 4, bevel: 0.8, extra: L(panel, { tone: "faint" }) + L(vents, { tone: "lo" }) + screws(REC, REC_H, 3), name: "s11.case" });
}
const PAPER = { x: REC.x + 12, y: ROLL_Y[0], w: REC.w - 24, d: ROLL_Y[1] - ROLL_Y[0], r: 0.3 };
{
  const trace = [];
  for (let i = 0; i <= 34; i += 1) {
    const y = PAPER.y + 1 + i;
    const wobble = Math.sin(i * 0.9) * 3 + Math.sin(i * 2.3) * 1.6 + (i > 24 ? 6 * Math.exp(-((i - 28) ** 2) / 4) : 0);
    trace.push([PAPER.x + PAPER.w / 2 + wobble, Math.min(y, PAPER.y + PAPER.d - 1)]);
  }
  const grid = [0.25, 0.5, 0.75].map((t) => k.lineOnTop([PAPER.x + PAPER.w * t, PAPER.y], [PAPER.x + PAPER.w * t, PAPER.y + PAPER.d], REC_H + 0.4, P)).join("");
  box("s11", PAPER, REC_H, 0.4, { tone: "hi", crease: "none" }, { steps: 2, bevel: 0, extra: L(grid, { tone: "faint" }) + L(k.onTop(trace, REC_H + 0.4, P), { tone: "mid" }), name: "s11.paper" });
}
for (const y of ROLL_Y) {
  for (const x of [REC.x + 6, REC.x + REC.w - 8]) box("s11", { x, y: y - 4, w: 2, d: 8, r: 0.6 }, REC_H, ROLL_Z + 3 - REC_H, { tone: "mid" }, { steps: 2, bevel: 0.3, extra: Dots([at([x + 1, y, ROLL_Z + 3])], { size: 0.4 }), name: "s11.cheek" });
  const F = G.frameOf([REC.x + 8, y, ROLL_Z], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  disc("s11", F, 0, REC.w - 16, ROLL_R, { tone: "hi" }, { name: "s11.roll" });
}
{
  const pivot = [REC.x + REC.w - 4, 75];
  cyl("s11", pivot[0], pivot[1], 2.4, REC_H, 6, { tone: "mid" }, { steps: 16, name: "s11.pivot" });
  const arm = { x: PAPER.x + PAPER.w / 2 - 1, y: 74, w: pivot[0] - (PAPER.x + PAPER.w / 2 - 1) - 2.4, d: 2, r: 0.6 };
  box("s11", arm, REC_H + 4, 1.2, { tone: "hi" }, { steps: 2, bevel: 0, ride: "pen", name: "s11.pen-arm" });
  cyl("s11", arm.x + 1, 75, 0.9, REC_H + 0.4, 3.6, { tone: "hi" }, { steps: 10, ride: "pen", name: "s11.pen" });
}

// ---------- Alarm bell (station 12) ----------

line("s12", [[REC.x + REC.w, 62, 6], [BELL_AT[0], 62, 6], [BELL_AT[0], BELL_BASE.y + BELL_BASE.d, 6]], 0.8, { name: "s12.cable", tone: "mid" });
box("s12", BELL_BASE, 0, 10, { tone: "mid" }, { steps: 3, bevel: 0.6, extra: screws(BELL_BASE, 10, 2.6), name: "s12.base" });
cyl("s12", BELL_AT[0], BELL_AT[1], 2.2, 10, BELL_Z - 10, { tone: "mid", crease: "none" }, { steps: 16, name: "s12.post" });
{
  const F = G.frameOf([BELL_AT[0], BELL_AT[1], BELL_Z], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
  const dome = (s) => 11 * Math.sqrt(Math.max(0, 1 - (s / 12) ** 2));
  const profile = [[0, 11]];
  for (let s = 1; s <= 12; s += 1) profile.push([s, dome(Math.min(s, 11.98)), 1]);
  profile[profile.length - 1] = [12, 0];
  const id = R.nameFor("s12.bell");
  put("s12", [BELL_AT[0], BELL_AT[1], BELL_Z + 5], S(G.solidOf(profile, F, P, { smooth: { slope: (s) => (-11 * (s / 144)) / Math.sqrt(Math.max(1e-3, 1 - (s / 12) ** 2)) } }), { tone: "hi", inner: L(G.arcOf(F, 2.5, dome(2.5), P), { tone: "faint" }) }), { name: id, shapes: [R.solid(A.solid(F, profile, { name: id }))] });
  cyl("s12", BELL_AT[0], BELL_AT[1], 2, BELL_Z + 12, 2.2, { tone: "mid" }, { steps: 6, bevel: 0.3, name: "s12.nut" });
  // Striker: a solenoid on the base and a ball that taps the rim.
  const reach = 11 + 2 + 1.5;
  const sx = BELL_AT[0] + Math.cos(40 * DEG) * reach;
  const sy = BELL_AT[1] + Math.sin(40 * DEG) * reach;
  cyl("s12", sx, sy, 3, 10, 6, { tone: "mid" }, { steps: 20, extra: L(k.sideArc(sx, sy, 3, 13, P, 16), { tone: "faint" }), name: "s12.solenoid" });
  cyl("s12", sx, sy, 0.8, 16, BELL_Z + 1 - 2 - 16, { tone: "hi", crease: "none" }, { steps: 10, ride: "striker", name: "s12.stem" });
  const ball = [sx, sy, BELL_Z + 1];
  const bid = R.nameFor("s12.striker");
  put("s12", ball, S(G.sphereOf(ball, 2, P), { tone: "hi" }), { ride: "striker", name: bid, shapes: [R.solid(A.ball(ball, 2, { name: bid }))] });
}

// ---------- Settle, page ----------

A.settle(R, P);
R.items.sort((a, b) => a.key - b.key);
const groups = R.items.map((item) => {
  const lift = G.dot3(item.move, V);
  return `<g class="it" data-piece="${item.piece}"${item.ride && RIDES.includes(item.ride) ? ` data-ride="${item.ride}" data-l="${lift.toFixed(3)}"` : ""} data-k="${item.key.toFixed(3)}">${item.svg}</g>`;
});

const unit = (vector) => {
  const o = at([0, 0, 0]);
  const p = at(vector);
  return [p[0] - o[0], p[1] - o[1]];
};
const DATA = {
  stations: STATIONS.map(([id, name, say, detail]) => ({ id, name, say, detail })),
  rides: RIDES,
  screen: Object.fromEntries(RIDES.map((ride) => [ride, unit(MOVES[ride])])),
  gate: (CG - CR) / (CD - CR),
};

const LABEL =
  "A mail-room franking bench standing for SetEmailCategory. A request card comes down a chute from a hopper onto a stamping carriage with six coloured category stamps, passes under a pin-tumbler arch that reads its token, and docks at the end of its rails. From the dock a hose runs into a low bulkhead wall, the platform's shared VNet. Behind the wall an arm on a rod reaches out of a gland, limited by a stop collar, to one lit pigeonhole in a mailbox cabinet and stamps the letter there. Two cables from a plate on the wall's cap feed a storage cabinet whose front is blanked off; a card catalogue cabinet with two drawers pulled out stands for private DNS. A chart recorder and an alarm bell sit at the front.";
const svg = k.figureSvg({ width: W, height: H, label: LABEL, body: [HALO, `<g class="sc-items">${groups.join("")}</g>`] });

const buttons = STATIONS.map(([id, name], index) => `<button type="button" class="sc-part" data-part="${id}"><span class="sc-num">${String(index + 1).padStart(2, "0")}</span>${name}</button>`).join("");
const caption =
  "A Power Automate flow calls the function through its custom connector. App Service Authentication checks the token at the gate, so only the connector's app gets through. The function then sets the category with its own managed identity, and Exchange RBAC lets that identity reach one shared mailbox and no other. All of its outbound traffic leaves through a subnet of the platform team's shared VNet, and storage has no public access: it's reachable only through the two private endpoints. Telemetry goes to Application Insights, and failures ring the alert.";
const stage = `<div class="sc-stage" tabindex="0" role="slider" aria-label="SetEmailCategory, end to end. Hover a part, or use the arrow keys to step through the 12 stations of a call; Escape clears the selection." aria-valuemin="1" aria-valuemax="${STATIONS.length}" aria-valuenow="1" aria-valuetext="${STATIONS[0][1]}">${svg}</div>`;
const corner = `<div class="iso-plate-corners" aria-hidden="true"><span class="iso-plate-corner" data-corner="fig">Fig 1</span><span class="iso-plate-corner" data-corner="title">Setting a category</span><span class="iso-plate-corner sc-hint" data-corner="hint">Hover a part · arrow keys</span><span class="iso-plate-corner" data-corner="readout" data-readout>12 stations · one call</span></div>`;
const body = `<style>${CSS()}</style><figure class="iso-figure sc"><div class="iso-plate">${corner}${stage}</div><figcaption class="iso-legend"><span class="sc-parts">${buttons}</span><span class="sc-detail" data-detail aria-live="polite"></span><span class="iso-caption">${caption}</span></figcaption></figure>`;

const LIVE = `
const D = ${JSON.stringify(DATA)};
const root = document.querySelector(".sc");
const stage = root.querySelector(".sc-stage");
const layer = stage.querySelector(".sc-items");
const readout = root.querySelector("[data-readout]");
const detail = root.querySelector("[data-detail]");
const buttons = [...root.querySelectorAll(".sc-part")];
const still = matchMedia("(prefers-reduced-motion: reduce)");
const nodes = [...layer.children].map((el) => ({ el, k: +el.dataset.k, l: +(el.dataset.l || 0), ride: el.dataset.ride || "", piece: el.dataset.piece }));
const share = Object.fromEntries(D.rides.map((ride) => [ride, { x: 0, v: 0 }]));
let selected = null, frame = 0, last = 0, clock = 0, visible = false, touring = !still.matches, tourClock = 0, quietTimer = 0, leaveTimer = 0, inside = false, order = nodes.map((_, i) => i);
const index = (id) => D.stations.findIndex((s) => s.id === id);
function targets(i) {
  return {
    carriage: i <= 0 ? 0 : i === 1 ? D.gate : 1,
    pins: i >= 1 ? 1 : 0,
    rod: i === 5 || i === 6 ? 1 : 0,
    pen: i === 10 && !still.matches ? 0.5 + 0.5 * Math.sin(clock * 4.2) : 0,
    striker: i === 11 && !still.matches ? (clock % 0.7 < 0.09 ? 1 : 0) : 0,
  };
}
function step(state, target, dt, seconds, calm) {
  if (calm) { state.x = target; state.v = 0; return false; }
  const w = 1 / seconds;
  for (let i = 0; i < 4; i += 1) { state.v += (w * w * (target - state.x) - 2 * w * state.v) * (dt / 4); state.x += state.v * (dt / 4); }
  if (Math.abs(target - state.x) < 1e-4 && Math.abs(state.v) < 1e-4) { state.x = target; state.v = 0; return false; }
  return true;
}
const SPEED = { carriage: 0.32, pins: 0.12, rod: 0.28, pen: 0.06, striker: 0.03 };
function draw() {
  for (const node of nodes) {
    if (!node.ride) continue;
    const s = share[node.ride].x;
    const [vx, vy] = D.screen[node.ride];
    const dx = vx * s, dy = vy * s;
    if (Math.abs(s) < 1e-4) { node.el.removeAttribute("transform"); holdStill(node.el, [0, 0]); }
    else { node.el.setAttribute("transform", "translate(" + dx.toFixed(2) + " " + dy.toFixed(2) + ")"); holdStill(node.el, [dx, dy]); }
  }
  const next = nodes.map((node, i) => [node.k + (node.ride ? node.l * share[node.ride].x : 0), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  if (next.some((v, i) => v !== order[i])) {
    const fragment = document.createDocumentFragment();
    next.forEach((i) => fragment.appendChild(nodes[i].el));
    layer.appendChild(fragment);
    order = next;
  }
  const i = selected ? index(selected) : -1;
  if (i >= 6) stage.setAttribute("data-stamped", ""); else stage.removeAttribute("data-stamped");
}
function select(id) {
  if (selected === id) return;
  selected = id;
  for (const node of nodes) node.piece === id ? node.el.setAttribute("data-on", "") : node.el.removeAttribute("data-on");
  if (id) stage.setAttribute("data-focus", ""); else stage.removeAttribute("data-focus");
  buttons.forEach((b) => (b.dataset.part === id ? b.setAttribute("data-on", "") : b.removeAttribute("data-on")));
  const i = index(id);
  const station = D.stations[i];
  readout.textContent = station ? String(i + 1).padStart(2, "0") + " · " + station.say : "12 stations · one call";
  detail.textContent = station ? station.detail : "";
  stage.setAttribute("aria-valuenow", String(Math.max(1, i + 1)));
  stage.setAttribute("aria-valuetext", station ? station.name + ". " + station.detail : "No station selected");
  run();
}
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  clock += dt;
  const calm = still.matches;
  if (touring) {
    tourClock += dt;
    const i = Math.floor(Math.max(0, tourClock - 1.4) / 2.6) % D.stations.length;
    if (tourClock > 1.4) select(D.stations[i].id);
  }
  const want = targets(selected ? index(selected) : -1);
  let moving = false;
  for (const ride of D.rides) moving = step(share[ride], want[ride], dt, SPEED[ride], calm) || moving;
  draw();
  const busy = touring || moving || (!calm && selected && (index(selected) === 10 || index(selected) === 11));
  frame = visible && busy ? requestAnimationFrame(tick) : 0;
}
function run() { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } }
function quiet() {
  touring = false;
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => { if (!inside && !still.matches) { touring = true; tourClock = 1.4 + Math.max(0, index(selected)) * 2.6; run(); } }, 3600);
}
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
function pieceAt(event) {
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const item = hit && hit.closest ? hit.closest(".it") : null;
  const piece = item ? item.dataset.piece.replace("-frame", "") : null;
  return piece && /^s\\d\\d$/.test(piece) ? piece : null;
}
stage.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch") return;
  inside = true;
  quiet();
  clearTimeout(leaveTimer);
  const id = pieceAt(event);
  if (id) select(id);
});
stage.addEventListener("pointerleave", () => { inside = false; quiet(); });
stage.addEventListener("pointerdown", (event) => { if (event.pointerType !== "touch") return; quiet(); const id = pieceAt(event); if (id) select(id); });
buttons.forEach((button) => {
  const show = () => { quiet(); select(button.dataset.part); };
  button.addEventListener("pointerenter", show);
  button.addEventListener("focus", show);
  button.addEventListener("click", show);
});
stage.addEventListener("keydown", (event) => {
  const i = selected ? index(selected) : -1;
  let next = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(D.stations.length - 1, i + 1);
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(0, i - 1);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = D.stations.length - 1;
  else if (event.key === "Escape") { event.preventDefault(); quiet(); select(null); return; }
  if (next === null) return;
  event.preventDefault();
  quiet();
  select(D.stations[next].id);
});
const narrow = matchMedia("(hover: none), (max-width: 480px)");
const hint = root.querySelector(".sc-hint");
const wording = () => { hint.textContent = narrow.matches ? "Tap a part" : "Hover a part · arrow keys"; };
wording();
narrow.addEventListener("change", wording);
if (still.matches) touring = false;
draw();
`;

function CSS() {
  return `
.sc{--cat-red:#e5484d;--cat-orange:#f76b15;--cat-yellow:#e2a336;--cat-green:#30a46c;--cat-blue:#3e63dd;--cat-purple:#8e4ec6;--sc-ring:#00000014;--sc-hover:#0000000a}
.iso:not([data-theme="light"]) .sc{--cat-red:#ff6369;--cat-orange:#ff8b3e;--cat-yellow:#f5c454;--cat-green:#4cc38a;--cat-blue:#7b9cff;--cat-purple:#b384f0;--sc-ring:#ffffff14;--sc-hover:#ffffff0a}
.sc .iso-plate{padding:52px 20px 56px;overflow:hidden}
.sc-stage{position:relative;touch-action:pan-y;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
.sc-stage:focus-visible{outline:1px solid var(--anatomy-muted);outline-offset:6px}
.sc-ink{stroke:none}
.sc-ink[data-c="red"]{fill:var(--cat-red)}.sc-ink[data-c="orange"]{fill:var(--cat-orange)}.sc-ink[data-c="yellow"]{fill:var(--cat-yellow)}
.sc-ink[data-c="green"]{fill:var(--cat-green)}.sc-ink[data-c="blue"]{fill:var(--cat-blue)}.sc-ink[data-c="purple"]{fill:var(--cat-purple)}
.sc-mark{opacity:0;transition:opacity 600ms var(--anatomy-ease)}
.sc-stage[data-stamped] .sc-mark{opacity:1}
.sc-stage[data-focus] .it:not([data-on]):not([data-piece="bench"]){--anatomy-hi:var(--anatomy-mid);--anatomy-mid:var(--anatomy-lo)}
.sc-stage[data-focus] .it[data-piece="bench"]{--anatomy-mid:var(--anatomy-lo)}
.it[data-on]{--anatomy-hi:var(--anatomy-lit);--anatomy-mid:var(--anatomy-hi)}
.it[data-on] .iso-top,.it[data-on] .tb-shine{fill:var(--anatomy-lit-top)}
.it[data-on] .iso-shade,.it[data-on] .tb-body{fill:var(--anatomy-lit-shade)}
.it[data-on] [data-seamless]>.iso-shade{stroke:var(--anatomy-lit-shade)}
.it[data-on] [data-seamless]>.iso-top{stroke:var(--anatomy-lit-top)}
.sc-parts{display:flex;flex-wrap:wrap;gap:6px}
.sc-part{display:inline-flex;align-items:baseline;gap:7px;padding:5px 10px;border:0;border-radius:999px;background:transparent;color:var(--anatomy-muted);font:12.5px/1.3 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;box-shadow:inset 0 0 0 1px var(--sc-ring);transition:color 160ms var(--anatomy-ease),background 160ms var(--anatomy-ease)}
.sc-part:hover,.sc-part:focus-visible,.sc-part[data-on]{color:var(--anatomy-strong);background:var(--sc-hover)}
.sc-part:focus-visible{outline:1px solid var(--anatomy-muted);outline-offset:2px}
.sc-num{font-family:var(--anatomy-mono);font-size:10.5px;letter-spacing:.04em;opacity:.7}
.sc-detail{min-height:3.1em;color:var(--anatomy-text)}
@media (max-width:560px){.sc .iso-plate{padding:48px 8px 64px}.sc-stage svg{width:112%;margin-left:-6%}.iso-plate-corner[data-corner="readout"]{max-width:62%;white-space:normal;text-align:right;line-height:1.35}}
`;
}

const page = k.pageHtml({ title: "Setting a category", theme: THEME, body, script: kitScript() + LIVE, width: 820 });
const file = THEME === "light" ? "solution-light.html" : "solution.html";
writeFileSync(join(HERE, file), page);
console.log("wrote", file, `${(page.length / 1024).toFixed(0)} KB`, `${R.items.length} items`, `${R.solids.length} solids`, `${ROUTES.length} lines`);

A.auditOrExit(R, P);
