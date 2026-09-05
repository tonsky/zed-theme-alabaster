import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileThemes } from './compiler.ts';

const usage = 'Usage: npm run build -- [source-directory] [output-file]';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nDefaults: src/ → themes/alabaster.json`);
    return;
  }
  if (args.length > 2 || args.some(arg => arg.startsWith('-'))) throw new Error(usage);
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const sourceDirectory = args[0] ? resolve(args[0]) : resolve(projectRoot, 'src');
  const outputFile = args[1] ? resolve(args[1]) : resolve(projectRoot, 'themes/alabaster.json');
  const files = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.css'))
    .map(entry => entry.name)
    .sort();
  if (!files.length) throw new Error(`No CSS source files found in ${sourceDirectory}`);
  const sources = await Promise.all(files.map(async name => {
    const file = resolve(sourceDirectory, name);
    return { file, css: await readFile(file, 'utf8') };
  }));
  const result = compileThemes(sources);
  // Finish every compilation before touching the output; replace it atomically.
  await mkdir(dirname(outputFile), { recursive: true });
  const temporaryFile = `${outputFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    await rename(temporaryFile, outputFile);
  } finally {
    await rm(temporaryFile, { force: true });
  }
  console.log(`Compiled ${result.themes.length} theme(s) → ${outputFile}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.toString() : error);
  process.exitCode = 1;
});
