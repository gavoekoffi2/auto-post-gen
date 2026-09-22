import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("a render error shows a way out instead of a blank page", () => {
  const boundary = read("src/components/ErrorBoundary.tsx");
  const app = read("src/App.tsx");

  // Without a boundary React unmounts the whole tree on the first uncaught
  // render error: white page, no message, no recovery, nothing reported.
  assert.match(boundary, /static getDerivedStateFromError/);
  assert.match(boundary, /componentDidCatch/);
  assert.match(boundary, /window\.location\.reload\(\)/);

  // A browser holding the previous index.html requests assets a deploy has
  // removed. That is a reload, not a crash, and should say so.
  assert.match(boundary, /ChunkLoadError/);
  assert.match(boundary, /Failed to fetch dynamically imported module/);

  // It must wrap everything, including the router and the providers.
  assert.match(app, /<ErrorBoundary>/);
  assert.ok(
    app.indexOf("<ErrorBoundary>") < app.indexOf("<QueryClientProvider"),
    "the boundary must be outside the providers it protects",
  );
});

test("the share preview is a raster image at the exact required size", () => {
  const html = read("index.html");

  // Facebook, LinkedIn, WhatsApp and X all ignore an SVG og:image, so the
  // link previewed with no image at all — on a social-media product.
  assert.match(html, /og:image" content="[^"]+\.png"/);
  assert.match(html, /twitter:image" content="[^"]+\.png"/);
  assert.doesNotMatch(html, /og:image" content="[^"]+\.svg"/);
  assert.doesNotMatch(html, /twitter:image" content="[^"]+\.svg"/);

  // Declared dimensions must match the file, or crawlers crop it themselves.
  assert.match(html, /og:image:width" content="1200"/);
  assert.match(html, /og:image:height" content="630"/);

  const png = readFileSync(join(root, "public/og-image.png"));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  // Crawlers skip images over a few MB.
  assert.ok(statSync(join(root, "public/og-image.png")).size < 2 * 1024 * 1024);

  // Regenerable, so editing the SVG cannot leave the PNG behind.
  assert.match(read("package.json"), /"og:image": "node scripts\/render-og-image\.mjs"/);
});

test("the production web server compresses and never caches index.html", () => {
  const conf = read("nginx.vps.conf");

  // index.html names the hashed bundles; a stale copy asks for files the
  // deploy already removed — the classic blank page after a release.
  assert.match(conf, /location = \/index\.html/);
  assert.match(conf, /no-store/);

  // ~1 MB of JS uncompressed, on mobile connections in West Africa.
  assert.match(conf, /gzip on;/);
  assert.match(conf, /application\/javascript/);
  assert.match(conf, /text\/css/);

  // nginx evaluates regex locations before a plain prefix, so the hashed
  // bundles need ^~ to actually get the long cache.
  assert.match(conf, /location \^~ \/assets\//);
  assert.ok(conf.indexOf("location ^~ /assets/") < conf.indexOf("location ~*"));

  // Braces balanced — a broken config means the container will not start.
  let depth = 0;
  for (const ch of conf.replace(/#.*$/gm, "")) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    assert.ok(depth >= 0, "unbalanced closing brace");
  }
  assert.equal(depth, 0, "unclosed block");
});

test("every location that sets a header still sets the security headers", () => {
  // nginx does NOT append: add_header directives are inherited from the parent
  // level ONLY when the current level declares none. So a location that adds a
  // Cache-Control silently drops CSP, HSTS, X-Frame-Options and the rest —
  // which is exactly what happened to /index.html, the one HTML document the
  // whole app is served from. There is no "inherit and extend" mode; the set
  // has to be repeated, and this test is what keeps the copies in step.
  const conf = read("nginx.vps.conf").replace(/#.*$/gm, "");
  const security = [
    "X-Frame-Options",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Strict-Transport-Security",
    "Content-Security-Policy",
  ];

  const blocks = [...conf.matchAll(/location[^{]*\{(.*?)\n {2}\}/gs)].map((m) => m[1]);
  assert.ok(blocks.length >= 4, "expected the location blocks to be found");

  let withHeaders = 0;
  for (const block of blocks) {
    if (!block.includes("add_header")) continue; // inherits the server block
    withHeaders++;
    for (const header of security) {
      assert.ok(block.includes(header), `a location sets add_header but drops ${header}`);
    }
  }
  assert.ok(withHeaders >= 3, "expected the cache-policy locations to be checked");

  // The document that matters most: GET / resolves to it by internal redirect.
  const indexBlock = blocks.find((b) => b.includes("no-store"));
  assert.ok(indexBlock, "the index.html location must exist");
  for (const header of security) {
    assert.ok(indexBlock.includes(header), `index.html would be served without ${header}`);
  }
});

test("container logs cannot fill the VPS disk", () => {
  const compose = read("docker-compose.vps.yml");
  // A full disk takes down every other service on the box, not just this one.
  assert.match(compose, /max-size: "10m"/);
  assert.match(compose, /max-file: "3"/);
});
