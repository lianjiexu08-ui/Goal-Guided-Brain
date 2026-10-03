#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LIMIT = 1000;
const SOURCE_ROOTS = [
  'app',
  'components',
  'hooks',
  'server',
  'lib',
  'scripts',
  'tests',
];
const EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.js',
  '.py',
  '.css',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.next',
  '.vinext',
  'build',
  'coverage',
  'dist',
  'fixture',
  'fixtures',
  'node_modules',
  'out',
  'test-fixture',
  'test-fixtures',
  'test_fixtures',
  'test-data',
  'testdata',
  '__testfixtures__',
  '__fixtures__',
]);

const projectRoot = process.cwd();

function printUsage() {
  process.stderr.write(
    'Usage: node scripts/check-file-lines.mjs [--changed <base>] [--json]\n',
  );
}

function parseArguments(argv) {
  let changedBase = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--changed') {
      const base = argv[index + 1];
      if (!base || base.startsWith('--')) {
        throw new Error('--changed requires a git base revision');
      }
      changedBase = base;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { changedBase, json };
}

function hasExcludedDirectory(relativePath) {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function isSourceFile(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const [root] = normalized.split('/');
  return (
    SOURCE_ROOTS.includes(root) &&
    !hasExcludedDirectory(relativePath) &&
    EXTENSIONS.has(path.extname(relativePath))
  );
}

function walkDirectory(directory, files = []) {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(projectRoot, absolutePath);
    if (hasExcludedDirectory(relativePath)) continue;

    if (entry.isDirectory()) {
      walkDirectory(absolutePath, files);
      continue;
    }
    if (entry.isFile() && isSourceFile(relativePath)) files.push(relativePath);
  }

  return files;
}

function changedSourceFiles(base) {
  const diffOutput = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMRTUXB', base, '--'],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  const untrackedOutput = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: projectRoot, encoding: 'utf8' },
  );

  return `${diffOutput}\n${untrackedOutput}`
    .split(/\r?\n/)
    .filter((file) => file && isSourceFile(file))
    .filter((file, index, files) => files.indexOf(file) === index)
    .sort((left, right) => left.localeCompare(right));
}

function countLines(filePath) {
  return countLineContents(fs.readFileSync(filePath, 'utf8'));
}

function countLineContents(contents) {
  if (!contents) return 0;
  const lines = contents.split(/\r\n|\r|\n/);
  const hasTrailingNewline = contents.endsWith('\n') || contents.endsWith('\r');
  return hasTrailingNewline ? lines.length - 1 : lines.length;
}

function lineCountAtRevision(base, relativePath) {
  try {
    const contents = execFileSync('git', ['show', `${base}:${relativePath}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return countLineContents(contents);
  } catch {
    return null;
  }
}

function inspectFiles(files, options) {
  return files
    .map((relativePath) => {
      const normalizedPath = relativePath.split(path.sep).join('/');
      const lines = countLines(path.resolve(projectRoot, relativePath));
      const baselineLines = options.changedBase
        ? lineCountAtRevision(options.changedBase, normalizedPath)
        : null;
      return { path: normalizedPath, lines, baselineLines };
    })
    .filter((file) => {
      if (file.lines <= LIMIT) return false;
      if (!options.changedBase || file.baselineLines === null) return true;
      // Existing legacy debt is allowed in incremental mode only when this
      // change reduces the file. New or growing files still fail immediately.
      return file.baselineLines <= LIMIT || file.lines > file.baselineLines;
    })
    .sort((left, right) => {
      if (right.lines !== left.lines) return right.lines - left.lines;
      return left.path.localeCompare(right.path);
    });
}

function buildReport(options, files, violations) {
  return {
    limit: LIMIT,
    scope: options.changedBase ? 'changed' : 'all',
    base: options.changedBase,
    scanned: files.length,
    violations,
    passed: violations.length === 0,
  };
}

function printHumanReport(report) {
  const scope =
    report.scope === 'changed'
      ? `changed sources from ${report.base}`
      : 'all hand-written sources';
  process.stdout.write(
    `GGB file-size quality gate (limit: ${report.limit} lines)\n`,
  );
  process.stdout.write(`Scope: ${scope}\n`);
  process.stdout.write(`Scanned: ${report.scanned} file(s)\n`);

  if (report.violations.length > 0) {
    process.stdout.write('Files over the limit:\n');
    for (const violation of report.violations) {
      process.stdout.write(`  ${violation.path} — ${violation.lines} lines\n`);
    }
    process.stdout.write(
      `Result: fail (${report.violations.length} file(s) exceed ${report.limit} lines).\n`,
    );
    return;
  }

  process.stdout.write(
    `Result: pass (no file exceeds ${report.limit} lines).\n`,
  );
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  let files;
  try {
    files = options.changedBase
      ? changedSourceFiles(options.changedBase)
      : SOURCE_ROOTS.flatMap((root) =>
          walkDirectory(path.join(projectRoot, root)),
        );
  } catch (error) {
    process.stderr.write(
      `Unable to determine the check set: ${error.message}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const violations = inspectFiles(files, options);
  const report = buildReport(options, files, violations);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report);
  }
  process.exitCode = report.passed ? 0 : 1;
}

main();
