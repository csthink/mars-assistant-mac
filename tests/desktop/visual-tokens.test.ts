import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowBackground } from "../../src/shared/appearance";
import {
  readAppearanceCache,
  writeAppearanceCache,
} from "../../src/main/appearance-cache";
import { expectedColors, expectedFont } from "./visual-tokens";

const renderer = "src/renderer";
const tokenFile = "tokens.css";

/** CSS named colours (CSS Color 4), matched as whole words in declaration values. */
const namedColors = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace " +
    "olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
    "papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
    "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey " +
    "snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
    "yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder " +
    "field fieldtext highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext"
  ).split(" "),
);
/** Layout values set from script (not colours): the recent-chats arrow offset. */
const layoutVariables = new Set(["--history-arrow"]);

type Declaration = { selector: string; property: string; value: string };

function declarations(css: string): Declaration[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Declaration[] = [];
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, " ");
    for (const part of rule[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0 || !part.trim()) continue;
      found.push({
        selector,
        property: part.slice(0, colon).trim(),
        value: part
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, " "),
      });
    }
  }
  return found;
}

/**
 * Colour problems of a style sheet outside the token file: a custom property defined outside the
 * token file, a reference to anything but a semantic token (or a layout variable set from script),
 * or a colour written as a literal (hex, colour function or named colour).
 */
export function colorProblems(file: string, css: string) {
  const problems: string[] = [];
  for (const { selector, property, value } of declarations(css)) {
    const where = `${file} ${selector} { ${property} }`;
    if (property.startsWith("--"))
      problems.push(`${where}: defines a custom property`);
    for (const [, name] of value.matchAll(/var\(\s*(--[\w-]+)/g))
      if (!name.startsWith("--c-") && !layoutVariables.has(name))
        problems.push(`${where}: refers to ${name}`);
    const literal = value.replace(/var\([^()]*\)/g, "");
    if (/#[0-9a-f]{3,8}\b/i.test(literal))
      problems.push(`${where}: hex colour`);
    if (/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(literal))
      problems.push(`${where}: colour function`);
    for (const word of literal.toLowerCase().match(/[a-z-]+/g) ?? [])
      if (namedColors.has(word))
        problems.push(`${where}: named colour ${word}`);
  }
  return problems;
}

/** Custom properties of the light (default) and dark blocks of the token file. */
function tokenBlocks(css: string) {
  const blocks: Record<"light" | "dark", Record<string, string>> = {
    light: {},
    dark: {},
  };
  for (const { selector, property, value } of declarations(css)) {
    if (!property.startsWith("--")) continue;
    const appearance =
      selector === ':root, :root[data-theme="light"]'
        ? "light"
        : selector === ':root[data-theme="dark"]'
          ? "dark"
          : undefined;
    assert.ok(appearance, `unexpected token block ${selector}`);
    blocks[appearance][property] = value;
  }
  return blocks;
}

const styleSheets = readdirSync(renderer).filter((name) =>
  name.endsWith(".css"),
);
const read = (name: string) => readFileSync(join(renderer, name), "utf8");

test("visual tokens: both appearances define the prototype colour table with the four contrast adjustments, and nothing else", () => {
  const blocks = tokenBlocks(read(tokenFile));
  const used = new Set<string>();
  for (const name of styleSheets)
    for (const [, token] of read(name).matchAll(/var\(\s*(--c-[\w-]+)/g))
      used.add(token);
  for (const appearance of ["light", "dark"] as const) {
    const defined = blocks[appearance];
    for (const [name, value] of Object.entries(defined))
      assert.equal(
        value.toLowerCase(),
        expectedColors[appearance][name],
        `${appearance} ${name}`,
      );
    assert.deepEqual(
      Object.keys(defined).sort(),
      [...used].sort(),
      `${appearance}: every token in use is defined and every defined token is in use`,
    );
  }
});

test("visual tokens: the root takes the prototype type, the canvas and the light appearance until the saved one is known", () => {
  const root = declarations(read(tokenFile)).filter(
    (d) => d.selector === ":root" && !d.property.startsWith("--"),
  );
  const font = root.find((d) => d.property === "font")?.value;
  assert.equal(
    font,
    `${expectedFont.size}/${expectedFont.lineHeight} ${expectedFont.family.join(", ")}`,
  );
  assert.deepEqual(
    root
      .filter((d) => d.property !== "font")
      .map((d) => `${d.property}: ${d.value}`),
    ["color: var(--c-text)", "background: var(--c-canvas)"],
  );
  const html = readFileSync(join(renderer, "index.html"), "utf8");
  assert.match(html, /<html lang="zh-CN" data-theme="light">/);
  // The page script sets the appearance before the first paint: it is a parser-blocking classic script in
  // the head (render-blocking), not deferred, asynchronous or in the body.
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  assert.match(head, /<script src="renderer\.js"><\/script>/);
  assert.doesNotMatch(html.slice(html.indexOf("</head>")), /<script/);
  const entry = readFileSync(join(renderer, "index.tsx"), "utf8");
  const firstImport = entry.match(/^import [^;]+;/m)?.[0];
  assert.equal(
    firstImport,
    'import "./tokens.css";',
    "the token sheet loads before any page style",
  );
});

test("visual tokens: page styles use only semantic tokens, with no colour literal and no colour-named variable", () => {
  const problems = styleSheets
    .filter((name) => name !== tokenFile)
    .flatMap((name) => colorProblems(name, read(name)));
  assert.deepEqual(problems, []);
  const scripts = readdirSync(renderer).filter((name) =>
    /\.(ts|tsx)$/.test(name),
  );
  for (const name of scripts)
    assert.doesNotMatch(
      read(name),
      /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b(?!\/)|\b(?:rgba?|hsla?)\(/i,
      `${name} writes a colour literal`,
    );
});

test("visual tokens: the colour check itself rejects each kind of violation", () => {
  const sample = [
    ".a { --palette-101116: #101116; }",
    ".b { color: var(--home-blue); }",
    ".c { background: #fff; }",
    ".d { border-color: rgb(0 0 0 / 30%); }",
    ".e { color: white; }",
    ".f { background: color-mix(in srgb, var(--c-red) 35%, black); }",
    ".g { box-shadow: 0 1px 2px hsl(0 0% 0%); }",
    ".ok { color: var(--c-text); left: var(--history-arrow, 40px); background: color-mix(in srgb, var(--c-red) 35%, transparent); }",
  ].join("\n");
  const problems = colorProblems("sample.css", sample);
  assert.deepEqual(
    problems.map((p) => p.split(" ")[1]),
    [".a", ".a", ".b", ".c", ".d", ".e", ".f", ".g"],
  );
  assert.ok(problems.every((p) => !p.includes(".ok")));
});

test("visual tokens: the native window background equals the canvas of each appearance", () => {
  assert.deepEqual(windowBackground, {
    light: expectedColors.light["--c-canvas"],
    dark: expectedColors.dark["--c-canvas"],
  });
});

test("visual tokens: the appearance cache reads back each saved choice, replaces it whole, and reads anything else as unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "appearance-cache-"));
  try {
    const path = join(dir, "appearance");
    assert.equal(readAppearanceCache(path), undefined);
    for (const choice of ["light", "dark", "auto"] as const) {
      writeAppearanceCache(path, choice);
      assert.equal(readAppearanceCache(path), choice);
      assert.deepEqual(readdirSync(dir), ["appearance"]);
    }
    for (const other of ["", "Dark", "system", "dark\ndark", "{}"]) {
      writeFileSync(path, other);
      assert.equal(readAppearanceCache(path), undefined, JSON.stringify(other));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
