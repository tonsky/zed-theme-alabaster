import postcss, { type Declaration, type Node, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { color, serializeRGB } from '@csstools/css-color-parser';
import {
  type ComponentValue,
  isFunctionNode,
  isSimpleBlockNode,
  isTokenNode,
  isWhiteSpaceOrCommentNode,
  parseListOfComponentValues,
  stringify,
} from '@csstools/css-parser-algorithms';
import { isTokenComma, isTokenIdent, isTokenNumber, isTokenString, tokenize } from '@csstools/css-tokenizer';

export interface SyntaxStyle {
  color?: string;
  background_color?: string;
  font_style?: 'normal' | 'italic' | 'oblique';
  font_weight?: number;
}

export interface PlayerStyle {
  cursor?: string;
  background?: string;
  selection?: string;
}

export interface Theme {
  name: string;
  appearance: 'light' | 'dark';
  style: Record<string, string | PlayerStyle[] | Record<string, SyntaxStyle>>;
}

export interface Source {
  css: string;
  file: string;
}

function meaningful(values: ComponentValue[]): ComponentValue[] {
  return values.filter(value => !isWhiteSpaceOrCommentNode(value));
}

function parseValue(value: string, node: Node): ComponentValue[] {
  const options = {
    onParseError: (error: Error) => { throw node.error(error.message); },
  };
  return parseListOfComponentValues(tokenize({ css: value }, options), options);
}

// Substitute component values, not strings: commas, quoted strings, and nested
// functions in fallbacks must retain their CSS token boundaries.
function variableResolver(variables: Map<string, Declaration>) {
  function expand(values: ComponentValue[], origin: Node, stack: string[]): ComponentValue[] {
    if (stack.length > 128) throw origin.error('Variable expansion exceeds 128 levels');
    return values.flatMap(value => {
      if (isFunctionNode(value) && value.getName().toLowerCase() === 'var') {
        const comma = value.value.findIndex(part => isTokenNode(part) && isTokenComma(part.value));
        const args = meaningful(comma < 0 ? value.value : value.value.slice(0, comma));
        const arg = args[0];
        if (args.length !== 1 || !isTokenNode(arg) || !isTokenIdent(arg.value)
          || !arg.value[4].value.startsWith('--') || arg.value[4].value === '--') {
          throw origin.error(`Invalid variable reference: ${value.toString()}`);
        }
        const name = arg.value[4].value;
        if (stack.includes(name)) {
          throw origin.error(`Cyclic variable reference: ${[...stack, name].join(' -> ')}`);
        }
        const declaration = variables.get(name);
        if (declaration) {
          return expand(parseValue(declaration.value, declaration), origin, [...stack, name]);
        }
        if (comma >= 0) return expand(value.value.slice(comma + 1), origin, stack);
        throw origin.error(`Undefined variable: ${name}`);
      }
      if (isFunctionNode(value) || isSimpleBlockNode(value)) {
        value.value = expand(value.value, origin, stack);
      }
      return [value];
    });
  }
  return (declaration: Declaration): ComponentValue[] =>
    expand(parseValue(declaration.value, declaration), declaration, [declaration.prop].filter(p => p.startsWith('--')));
}

function hexColor(values: ComponentValue[], declaration: Declaration): string {
  const parts = meaningful(values);
  const data = parts.length === 1 ? color(parts[0]) : false;
  if (!data || typeof data.alpha !== 'number') {
    throw declaration.error(`Unsupported or invalid color: ${stringify([values])}`);
  }
  // CSS Tools performs perceptual sRGB gamut mapping and converts missing
  // channels to display values. Its serializer emits rounded RGB byte tokens.
  const rgb = serializeRGB(data).value
    .filter(isTokenNode)
    .filter(part => isTokenNumber(part.value))
    .slice(0, 3)
    .map(part => Number(part.value[1]));
  const alpha = Number.isNaN(data.alpha) ? 0 : data.alpha;
  const bytes = [...rgb, Math.round(Math.max(0, Math.min(1, alpha)) * 255)];
  if (rgb.length !== 3 || bytes.some(byte => !Number.isFinite(byte))) {
    throw declaration.error(`Could not resolve color: ${stringify([values])}`);
  }
  return '#' + bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// A descendant class chain is a dotted Zed key, not a DOM selector. Other CSS
// selectors are rejected instead of being silently interpreted as theme keys.
function selectorPaths(rule: Rule): string[] {
  let selectors;
  try {
    selectors = selectorParser().astSync(rule.selector);
  } catch (error) {
    throw rule.error(`Invalid selector: ${(error as Error).message}`);
  }
  if ('trailingComma' in selectors && selectors.trailingComma) {
    throw rule.error(`Invalid class selector: ${rule.selector}`);
  }
  return selectors.nodes.map(selector => {
    const classes: string[] = [];
    let expectClass = true;
    for (const part of selector.nodes) {
      if (part.type === 'comment') continue;
      if (expectClass && part.type === 'class' && /^[\w-]+$/.test(part.value)) {
        classes.push(part.value);
        expectClass = false;
      } else if (!expectClass && part.type === 'combinator' && part.value.trim() === '') {
        expectClass = true;
      } else {
        throw rule.error(`Only descendant class selectors are supported: ${selector.toString()}`);
      }
    }
    if (expectClass || !classes.length) throw rule.error(`Invalid class selector: ${selector.toString()}`);
    return classes.join('.');
  });
}

export function compileTheme(css: string, file = '<css>'): Theme {
  const root = postcss.parse(css, { from: file });
  const variables = new Map<string, Declaration>();
  for (const node of root.nodes) {
    if (node.type === 'comment') continue;
    if (node.type !== 'rule') throw node.error('Expected :root, style, syntax, or playerN block');
    if (node.selector !== ':root') continue;
    for (const child of node.nodes) {
      if (child.type === 'comment') continue;
      if (child.type !== 'decl' || !/^--[\w-]+$/.test(child.prop)) {
        throw child.error(':root only supports custom property declarations');
      }
      if (child.important) throw child.error('!important is not supported');
      variables.set(child.prop, child);
    }
  }
  const resolve = variableResolver(variables);
  // Validate even unused definitions so typos and cycles cannot hide in palettes.
  for (const declaration of variables.values()) resolve(declaration);

  function metadata(name: string): string {
    const declaration = variables.get(name);
    if (!declaration) throw root.error(`Missing required metadata: ${name}`);
    const values = meaningful(resolve(declaration));
    const value = values[0];
    if (values.length !== 1 || !isTokenNode(value)
      || (!isTokenString(value.value) && !isTokenIdent(value.value))) {
      throw declaration.error(`${name} must be a quoted string or identifier`);
    }
    const result = value.value[4].value;
    if (!result.trim()) throw declaration.error(`${name} must not be empty`);
    return result;
  }

  const name = metadata('--name');
  const appearance = metadata('--appearance');
  if (appearance !== 'light' && appearance !== 'dark') {
    throw variables.get('--appearance')!.error('--appearance must be "light" or "dark"');
  }

  const style: Theme['style'] = Object.create(null);
  const syntax: Record<string, SyntaxStyle> = Object.create(null);
  const players = new Map<number, PlayerStyle>();
  let hasSyntax = false;

  function declarationValue(declaration: Declaration, section: string): string | number {
    if (declaration.important) throw declaration.error('!important is not supported');
    const values = resolve(declaration);
    const property = declaration.prop;
    if (property === 'color' || (section === 'syntax' && property === 'background-color')) {
      return hexColor(values, declaration);
    }
    const text = stringify([values]).trim();
    if (section === 'syntax' && property === 'font-style' && ['normal', 'italic', 'oblique'].includes(text)) {
      return text;
    }
    if (section === 'syntax' && property === 'font-weight') {
      const weight = text === 'normal' ? 400 : text === 'bold' ? 700 : Number(text);
      if (Number.isInteger(weight) && weight >= 100 && weight <= 900 && weight % 100 === 0) return weight;
    }
    throw declaration.error(`Unsupported property or value in ${section}: ${property}: ${text}`);
  }

  function visit(rule: Rule, section: string, parentPaths: string[], player?: PlayerStyle): void {
    const children = selectorPaths(rule);
    const paths = parentPaths.flatMap(parent => children.map(path => parent ? `${parent}.${path}` : path));
    for (const node of rule.nodes) {
      if (node.type === 'comment') continue;
      if (node.type === 'rule') {
        visit(node, section, paths, player);
        continue;
      }
      if (node.type !== 'decl') throw node.error('Only declarations and nested class rules are supported');
      const value = declarationValue(node, section);
      for (const path of paths) {
        if (section === 'syntax') {
          const entry = syntax[path] ??= {};
          Object.assign(entry, { [node.prop.replaceAll('-', '_')]: value });
        } else if (player) {
          if (!['cursor', 'background', 'selection'].includes(path)) throw rule.error(`Unknown player property: ${path}`);
          Object.assign(player, { [path]: value });
        } else {
          if (path === 'players' || path === 'syntax') throw rule.error(`Reserved style key: ${path}`);
          style[path] = value as string;
        }
      }
    }
  }

  for (const node of root.nodes) {
    if (node.type !== 'rule' || node.selector === ':root') continue;
    const section = node.selector;
    let player: PlayerStyle | undefined;
    if (section === 'syntax') {
      hasSyntax = true;
    } else if (section !== 'style') {
      const match = /^player([1-9]\d*)$/.exec(section);
      if (!match) throw node.error(`Unknown section: ${section}`);
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index)) throw node.error(`Invalid player number: ${match[1]}`);
      player = players.get(index) ?? {};
      players.set(index, player);
    }
    for (const child of node.nodes) {
      if (child.type === 'comment') continue;
      if (child.type !== 'rule') throw child.error(`${section} only supports class rules`);
      visit(child, section, [''], player);
    }
  }
  if (players.size) {
    const ordered = [...players.entries()].sort(([a], [b]) => a - b);
    if (ordered.some(([index], offset) => index !== offset + 1)) {
      throw root.error('Player blocks must be consecutive, starting at player1');
    }
    style.players = ordered.map(([, player]) => player);
  }
  if (hasSyntax) style.syntax = syntax;
  return { name, appearance, style };
}

export function compileThemes(sources: Source[]) {
  if (!sources.length) throw new Error('No CSS source files found');
  const names = new Set<string>();
  const themes = sources.map(({ css, file }) => {
    const theme = compileTheme(css, file);
    if (names.has(theme.name)) throw new Error(`${file}: Duplicate theme name: ${theme.name}`);
    names.add(theme.name);
    return theme;
  });
  return {
    $schema: 'https://zed.dev/schema/themes/v0.2.0.json',
    name: 'Alabaster',
    author: 'Nikita Prokopov <niki@tonsky.me>',
    themes,
  };
}
