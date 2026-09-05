import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileTheme, compileThemes, type SyntaxStyle } from './compiler.ts';

const metadata = ':root { --name: "Test Theme"; --appearance: "light"; }';
const compile = (body: string) => compileTheme(`${metadata}\n${body}`, 'fixture.css');
const compileColor = (value: string) => compile(`style { .sample { color: ${value}; } }`).style.sample;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('maps sections, descendant selectors, comma lists, fonts, and numbered players', () => {
  const theme = compile(`
    /* A comment outside any section */
    style {
      .border { color: #abc; }
      .scrollbar .thumb .hover_background, .other { color: #1234; }
    }
    player2 { .cursor { color: blue; } }
    player1 { .cursor, .background { color: red; } .selection { color: transparent; } }
    syntax {
      .string, .text .literal { color: green; background-color: white; }
      .string .escape { background-color: #eee; }
      .title { font-weight: bold; }
      .emphasis { font-style: italic; }
      .emphasis .strong { font-weight: 700; }
    }
  `);
  assert.deepEqual(plain(theme), {
    name: 'Test Theme', appearance: 'light', style: {
      border: '#aabbccff', 'scrollbar.thumb.hover_background': '#11223344', other: '#11223344',
      players: [{ cursor: '#ff0000ff', background: '#ff0000ff', selection: '#00000000' }, { cursor: '#0000ffff' }],
      syntax: {
        string: { color: '#008000ff', background_color: '#ffffffff' },
        'text.literal': { color: '#008000ff', background_color: '#ffffffff' },
        'string.escape': { background_color: '#eeeeeeff' },
        title: { font_weight: 700 }, emphasis: { font_style: 'italic' },
        // Dotted keys do not implicitly inherit declarations from shorter keys.
        'emphasis.strong': { font_weight: 700 },
      },
    },
  });
  const syntax = theme.style.syntax as Record<string, SyntaxStyle>;
  assert.notEqual(syntax.string, syntax['text.literal']);
});

test('nested class blocks expand comma lists as a Cartesian product', () => {
  const theme = compile(`style {
    .a, .b {
      color: black;
      .c, .d { color: white; .e { color: red; } }
    }
  }`);
  assert.deepEqual(Object.keys(theme.style), ['a', 'b', 'a.c', 'a.d', 'b.c', 'b.d', 'a.c.e', 'a.d.e', 'b.c.e', 'b.d.e']);
  assert.equal(theme.style['b.d.e'], '#ff0000ff');
});

test('repeated rules merge declarations in source order', () => {
  const theme = compile(`
    syntax {
      .a, .b { color: red; background-color: white; }
      .a { color: blue; }
    }
    syntax { .a { font-weight: normal; font-style: normal; } }
    style { .x { color: black; color: white; } }
  `);
  assert.deepEqual(plain(theme.style.syntax), {
    a: { color: '#0000ffff', background_color: '#ffffffff', font_weight: 400, font_style: 'normal' },
    b: { color: '#ff0000ff', background_color: '#ffffffff' },
  });
  assert.equal(theme.style.x, '#ffffffff');
});

test('variables support forward references, aliases, channel values, and nested fallbacks', () => {
  const theme = compile(`
    :root {
      --alias: var(--base);
      --base: rgb(var(--red) 0 0 / var(--opacity));
      --red: 255;
      --opacity: 50%;
      --fallback: var(--missing, var(--also-missing, rgb(0, 0, 255)));
    }
    style {
      .a { color: var(--alias); }
      .b { color: var(--fallback); }
      .c { color: var(--missing, color-mix(in srgb, red, blue)); }
      .d { color: rgb(0 0 0 var(--missing,)); }
      .e { color: var(--alias, var(--not-defined)); }
    }
  `);
  assert.deepEqual(plain(theme.style), { a: '#ff000080', b: '#0000ffff', c: '#800080ff', d: '#000000ff', e: '#ff000080' });
});

test('metadata uses CSS strings, escapes, aliases, and identifiers', () => {
  const theme = compileTheme(`:root {
    --name: var(--label);
    --label: "Alabaster \\4c ight";
    --appearance: light;
  }`);
  assert.equal(theme.name, 'Alabaster Light');
  assert.equal(theme.appearance, 'light');
  assert.equal(compileTheme(':root { --name: "var(--literal)"; --appearance: dark; }').name, 'var(--literal)');
});

for (const [input, expected] of [
  ['#12345678', '#12345678'], ['#ABC', '#aabbccff'], ['#abcd', '#aabbccdd'],
  ['transparent', '#00000000'], ['rebeccapurple', '#663399ff'],
  ['rgb(255, 0, 0)', '#ff0000ff'], ['rgba(255, 0, 0, .5)', '#ff000080'],
  ['rgb(100% 0% 0% / 25%)', '#ff000040'], ['rgb(1 2 3 / none)', '#01020300'],
  ['hsl(120deg 100% 50%)', '#00ff00ff'], ['hsla(240, 100%, 50%, .5)', '#0000ff80'],
  ['hwb(240 0% 0%)', '#0000ffff'], ['lab(0% 0 0)', '#000000ff'],
  ['lch(100% 0 0)', '#ffffffff'], ['oklab(0 0 0)', '#000000ff'],
  ['oklch(100% 0 120)', '#ffffffff'], ['color(srgb 1 0 0)', '#ff0000ff'],
  ['color(srgb-linear 1 1 1)', '#ffffffff'], ['color(display-p3 1 0 0)', '#ff3428ff'],
  ['color(a98-rgb 0 0 0)', '#000000ff'], ['color(prophoto-rgb 0 0 0)', '#000000ff'],
  ['color(rec2020 0 0 0)', '#000000ff'], ['color(xyz 0 0 0)', '#000000ff'],
  ['color(xyz-d50 0 0 0)', '#000000ff'], ['color(xyz-d65 0 0 0)', '#000000ff'],
  ['color-mix(in srgb, red 50%, blue)', '#800080ff'],
  ['color-mix(in srgb, red 20%, transparent)', '#ff000033'],
  ['color-mix(in oklch, #016ccc 25%, white)', '#c6dbf5ff'],
  ['color-mix(in srgb, color-mix(in srgb, black, white), white)', '#bfbfbfff'],
  ['rgb(from red calc(r / 2) g b / 50%)', '#80000080'],
  ['oklch(from red calc(l + 0.1) c h)', '#ff7866ff'],
  ['rgb(calc(200 + 55) 0 0)', '#ff0000ff'],
]) {
  test(`resolves color ${input}`, () => assert.equal(compileColor(input), expected));
}

test('hex RGBA values round-trip without changing bytes', () => {
  const colors = Array.from({ length: 256 }, (_, i) =>
    '#' + [i, 255 - i, (i * 37) % 256, i].map(x => x.toString(16).padStart(2, '0')).join(''));
  const theme = compile(`style { ${colors.map((c, i) => `.c${i} { color: ${c}; }`).join('\n')} }`);
  colors.forEach((c, i) => assert.equal(theme.style[`c${i}`], c));
});

for (const [body, error] of [
  ['style { .x { color: var(--missing); } }', /Undefined variable: --missing/],
  [':root { --a: var(--b); --b: var(--a); }', /Cyclic variable reference/],
  ['style { .x { color: var(-green-bg); } }', /Invalid variable reference/],
  ['style { .x { color: currentColor; } }', /Unsupported or invalid color/],
  ['style { .x { color: red blue; } }', /Unsupported or invalid color/],
  ['style { .x { color: rgb(255 0 0) garbage; } }', /Unsupported or invalid color/],
  ['style { .x { color: env(accent); } }', /Unsupported or invalid color/],
  ['style { .x { colour: red; } }', /Unsupported property/],
  ['syntax { .x { font-weight: 950; } }', /Unsupported property/],
  ['syntax { .x { font-style: bold; } }', /Unsupported property/],
  ['syntax { .x { font-style: null; } }', /Unsupported property/],
  ['style { .x { --local: red; color: var(--local); } }', /Unsupported property/],
  [':root { color: red; }', /custom property declarations/],
  ['style { color: red; }', /only supports class rules/],
  ['style { .x { color: red !important; } }', /!important is not supported/],
  [':root { --a: red !important; }', /!important is not supported/],
  ['style { .x.y { color: red; } }', /Only descendant class selectors/],
  ['style { .x > .y { color: red; } }', /Only descendant class selectors/],
  ['style { .x:hover { color: red; } }', /Only descendant class selectors/],
  ['style { #x { color: red; } }', /Only descendant class selectors/],
  ['style { .x, { color: red; } }', /Invalid class selector/],
  ['style { .players { color: red; } }', /Reserved style key/],
  ['other {}', /Unknown section/],
  ['player2 { .cursor { color: red; } }', /consecutive/],
  ['player0 {}', /Unknown section/],
  ['player1 { .other { color: red; } }', /Unknown player property/],
  ['@import "other.css";', /Expected :root/],
  ['style { @media screen {} }', /only supports class rules/],
] as const) {
  test(`rejects invalid input: ${body}`, () => {
    assert.throws(() => compile(body), error);
    assert.throws(() => compile(body), /fixture\.css:\d+:\d+/);
  });
}

test('rejects missing or invalid metadata', () => {
  assert.throws(() => compileTheme(''), /Missing required metadata: --name/);
  assert.throws(() => compileTheme(':root { --name: "X"; }'), /--appearance/);
  assert.throws(() => compileTheme(':root { --name: ""; --appearance: light; }'), /must not be empty/);
  assert.throws(() => compileTheme(':root { --name: X Y; --appearance: light; }'), /quoted string or identifier/);
  assert.throws(() => compileTheme(':root { --name: X; --appearance: blue; }'), /must be "light" or "dark"/);
});

test('combines themes with hardcoded envelope and isolated variable environments', () => {
  const sources = ['light', 'dark'].map(appearance => ({
    file: `${appearance}.css`,
    css: `:root { --name: "${appearance}"; --appearance: "${appearance}"; --base: ${appearance === 'light' ? 'white' : 'black'}; }
      style { .background { color: var(--base); } }`,
  }));
  const result = compileThemes(sources);
  assert.equal(result.name, 'Alabaster');
  assert.equal(result.author, 'Nikitonsky');
  assert.equal(result.$schema, 'https://zed.dev/schema/themes/v0.2.0.json');
  assert.deepEqual(result.themes.map(t => t.style.background), ['#ffffffff', '#000000ff']);
  assert.throws(() => compileThemes([sources[0], sources[0]]), /Duplicate theme name/);
  assert.throws(() => compileThemes([]), /No CSS source files/);
  assert.throws(() => compileThemes([sources[0], {
    file: 'isolated.css', css: `${metadata} style { .x { color: var(--base); } }`,
  }]), /Undefined variable/);
});

test('repository CSS compiles with resolved colors and expanded syntax scopes', async () => {
  const css = await readFile(new URL('../src/alabaster_light.css', import.meta.url), 'utf8');
  const theme = compileTheme(css, 'src/alabaster_light.css');
  assert.equal(theme.name, 'Alabaster Light');
  const syntax = theme.style.syntax as Record<string, SyntaxStyle>;
  assert.deepEqual(syntax.string, syntax['text.literal']);
  assert.deepEqual(syntax.number, syntax.boolean);
  assert.deepEqual(syntax.number, syntax.constant);
  assert.deepEqual(syntax['function.definition'], syntax['type.class.definition']);
  assert.equal(syntax['diff.plus'].background_color, '#ebfcd6ff');
  assert.ok(Array.isArray(theme.style.players));
  assert.equal(theme.style.players.length, 8);
  function checkColors(value: unknown): void {
    if (typeof value === 'string') {
      assert.match(value, /^(#[0-9a-f]{8}|italic|normal|oblique)$/);
    } else if (value && typeof value === 'object') {
      for (const entry of Object.values(value)) checkColors(entry);
    }
  }
  checkColors(theme.style);
});

test('CLI sorts sources, builds deterministically, and preserves output on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alabaster-test-'));
  try {
    const src = join(dir, 'src');
    const output = join(dir, 'themes', 'alabaster.json');
    await mkdir(src);
    await writeFile(join(src, 'b.css'), metadata.replace('Test Theme', 'B'));
    await writeFile(join(src, 'a.css'), metadata.replace('Test Theme', 'A'));
    await writeFile(join(src, 'ignored.txt'), 'not css');
    const cli = fileURLToPath(new URL('./build.ts', import.meta.url));
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', cli, src, output], { encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const before = await readFile(output, 'utf8');
    assert.deepEqual(JSON.parse(before).themes.map((theme: { name: string }) => theme.name), ['A', 'B']);
    assert.equal(run().status, 0);
    assert.equal(await readFile(output, 'utf8'), before);
    await writeFile(join(src, 'b.css'), `${metadata} style { .x { color: var(--missing); } }`);
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /b\.css:\d+:\d+.*Undefined variable/);
    assert.equal(await readFile(output, 'utf8'), before);
    assert.deepEqual(await readdir(join(dir, 'themes')), ['alabaster.json']);
    await rm(join(src, 'a.css'));
    await rm(join(src, 'b.css'));
    assert.equal(run().status, 1);
    assert.equal(await readFile(output, 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
