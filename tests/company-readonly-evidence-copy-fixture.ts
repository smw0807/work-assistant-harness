import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import type { CompanyReadonlyRegistration } from '../src/domain/company-readonly.js';

interface SyntheticObject { oid: string; type: 'blob' | 'tree' | 'commit'; content: Buffer }
interface TreeEntry { name: string; object: SyntheticObject }
const sha1 = (bytes: Uint8Array): Buffer => createHash('sha1').update(bytes).digest();
const wrapped = (object: Pick<SyntheticObject, 'type' | 'content'>): Buffer =>
  Buffer.concat([Buffer.from(`${object.type} ${object.content.length}\0`), object.content]);
const objectPath = (root: string, oid: string): string => join(root, '.git/objects', oid.slice(0, 2), oid.slice(2));
const writeFile = (path: string, bytes: string | Uint8Array): void => {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); fs.writeFileSync(path, bytes, { mode: 0o600 });
};

/** A non-delta pack made only from objects generated below, then independently indexed by isomorphic-git. */
const packSyntheticObjects = (objects: SyntheticObject[]): Buffer => {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  const entries = objects.map(object => {
    const type = { commit: 1, tree: 2, blob: 3 }[object.type];
    let remaining = Math.floor(object.content.length / 16);
    const length = [(type << 4) | (object.content.length & 15) | (remaining ? 128 : 0)];
    while (remaining) {
      const next = remaining & 127; remaining = Math.floor(remaining / 128); length.push(next | (remaining ? 128 : 0));
    }
    return Buffer.concat([Buffer.from(length), deflateSync(object.content)]);
  });
  const body = Buffer.concat([header, ...entries]); return Buffer.concat([body, sha1(body)]);
};

/**
 * Test-only construction of fixed synthetic source/copy roots. It accepts no source path or export input.
 * Objects are captured when this fixture creates them; this is not an extractor for an existing large pack.
 */
export const createCompanyEvidenceCopyFixture = async (context: TestContext, sourceLayout: 'small-loose' | 'over-limit-pack' = 'small-loose') => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-evidence-copy-')));
  fs.chmodSync(root, 0o700); context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'synthetic-source'), copyRoot = join(root, 'synthetic-review-copy');
  fs.mkdirSync(sourceRoot, { mode: 0o700 }); fs.mkdirSync(copyRoot, { mode: 0o700 });
  const objects = new Map<string, SyntheticObject>();
  const createObject = (type: SyntheticObject['type'], value: string | Buffer): SyntheticObject => {
    const content = typeof value === 'string' ? Buffer.from(value) : value;
    const oid = sha1(wrapped({ type, content })).toString('hex');
    const object = { oid, type, content }; objects.set(oid, object); return object;
  };
  const tree = (entries: TreeEntry[]): SyntheticObject => createObject('tree', Buffer.concat([...entries]
    .sort((left, right) => Buffer.compare(Buffer.from(left.name + (left.object.type === 'tree' ? '/' : '')),
      Buffer.from(right.name + (right.object.type === 'tree' ? '/' : ''))))
    .map(({ name, object }) => Buffer.concat([Buffer.from(`${object.type === 'tree' ? '40000' : '100644'} ${name}\0`), Buffer.from(object.oid, 'hex')]))));
  const selectedFiles = {
    'README.md': '# Synthetic six-file review\nOnly selected evidence is available.\n',
    'src/api/controller.ts': "import { service } from '../service/service';\nexport const controller = () => service();\n",
    'src/entry.ts': "import { controller } from './api/controller';\nexport const entry = () => controller();\n",
    'src/service/service.ts': "import { value } from '../shared/value';\nexport const service = () => value;\n",
    'src/shared/value.ts': 'export const value = 42;\n',
    'tests/service.test.ts': '// Synthetic test source is evidence only; it is never executed.\nexport const expected = 42;\n',
  };
  const omittedFiles = { 'docs/internal.md': 'SYNTHETIC_OMITTED_DOCUMENT_BODY\n',
    'src/api/unselected.ts': 'export const omitted = "SYNTHETIC_OMITTED_API_BODY";\n',
    'src/private-note.ts': 'export const note = "SYNTHETIC_OMITTED_NOTE_BODY";\n' };
  const files = { ...selectedFiles, ...omittedFiles };
  const blobs = new Map(Object.entries(files).map(([path, value]) => [path, createObject('blob', value)]));
  const entry = (path: string): TreeEntry => ({ name: path.split('/').at(-1)!, object: blobs.get(path)! });
  const apiTree = tree([entry('src/api/controller.ts'), entry('src/api/unselected.ts')]);
  const serviceTree = tree([entry('src/service/service.ts')]), sharedTree = tree([entry('src/shared/value.ts')]);
  const srcTree = tree([{ name: 'api', object: apiTree }, entry('src/entry.ts'), entry('src/private-note.ts'),
    { name: 'service', object: serviceTree }, { name: 'shared', object: sharedTree }]);
  const testTree = tree([entry('tests/service.test.ts')]), docsTree = tree([entry('docs/internal.md')]);
  const rootTree = tree([entry('README.md'), { name: 'docs', object: docsTree }, { name: 'src', object: srcTree }, { name: 'tests', object: testTree }]);
  const historyBlob = createObject('blob', 'SYNTHETIC_OMITTED_HISTORY_BODY\n');
  const historyTree = tree([{ name: 'history.txt', object: historyBlob }]);
  const identity = 'Synthetic Evidence Copy <fixture@example.invalid> 1704067200 +0000';
  const historyCommit = createObject('commit', `tree ${historyTree.oid}\nauthor ${identity}\ncommitter ${identity}\n\nSynthetic fixture history\n`);
  const commit = createObject('commit', `tree ${rootTree.oid}\nparent ${historyCommit.oid}\nauthor ${identity}\ncommitter ${identity}\n\nSynthetic fixed review commit\n`);
  if (sourceLayout === 'over-limit-pack') {
    for (let index = 0; index < 4097; index++) createObject('blob', `Synthetic unrelated packed object ${index}\n`);
  }

  await git.init({ fs, dir: sourceRoot, defaultBranch: 'main' });
  for (const [path, value] of Object.entries(files)) {
    writeFile(join(sourceRoot, path), value); await git.add({ fs, dir: sourceRoot, filepath: path });
  }
  writeFile(join(sourceRoot, '.git/HEAD'), `${commit.oid}\n`);
  let sourcePackPath: string | null = null, packedObjectCount = 0, indexedObjectCount = 0;
  if (sourceLayout === 'over-limit-pack') {
    const packedObjects = [...objects.values()], pack = packSyntheticObjects(packedObjects);
    const packName = `pack-${sha1(pack.subarray(0, -20)).toString('hex')}.pack`;
    sourcePackPath = join(sourceRoot, '.git/objects/pack', packName); writeFile(sourcePackPath, pack);
    const indexed = await git.indexPack({ fs, dir: sourceRoot, filepath: `.git/objects/pack/${packName}` });
    assert.deepEqual([...indexed.oids].sort(), [...objects.keys()].sort());
    packedObjectCount = packedObjects.length; indexedObjectCount = indexed.oids.length;
    for (const name of fs.readdirSync(join(sourceRoot, '.git/objects'))) {
      if (/^[a-f0-9]{2}$/u.test(name)) fs.rmSync(join(sourceRoot, '.git/objects', name), { recursive: true });
    }
  } else {
    for (const object of objects.values()) writeFile(objectPath(sourceRoot, object.oid), deflateSync(wrapped(object)));
  }

  // Preserve original commit and complete ancestor-tree bytes. Do not rebuild a tree or create a copy commit.
  const ancestorTrees = [rootTree, srcTree, apiTree, serviceTree, sharedTree, testTree];
  const selectedPaths = Object.keys(selectedFiles).sort();
  const copiedObjects = [commit, ...ancestorTrees, ...selectedPaths.map(path => blobs.get(path)!)];
  await git.init({ fs, dir: copyRoot, defaultBranch: 'main' });
  for (const [path, value] of Object.entries(selectedFiles)) {
    writeFile(join(copyRoot, path), value); await git.add({ fs, dir: copyRoot, filepath: path });
  }
  for (const object of copiedObjects) writeFile(objectPath(copyRoot, object.oid), deflateSync(wrapped(object)));
  writeFile(join(copyRoot, '.git/HEAD'), `${commit.oid}\n`);
  const registration: CompanyReadonlyRegistration = { version: 'company-readonly-registration-v1', repoId: 'synthetic-evidence-copy',
    sourceRoot: copyRoot, baseCommit: commit.oid, question: 'Explain only these selected six files and identify missing evidence.',
    readRanges: selectedPaths.map(path => ({ path, startLine: 1, endLine: 1 })), reviewPaths: selectedPaths };
  return { root, sourceRoot, copyRoot, registration, sourceRegistration: { ...registration, sourceRoot }, selectedFiles,
    selectedPaths, omittedFiles, commit, ancestorTrees, copiedObjects, sourcePackPath,
    sourceIndexPath: sourcePackPath?.replace(/\.pack$/u, '.idx') ?? null, packedObjectCount, indexedObjectCount,
    omittedObjects: [historyCommit, historyTree, historyBlob, docsTree, ...Object.keys(omittedFiles).map(path => blobs.get(path)!)],
    copyObjectPaths: { commit: objectPath(copyRoot, commit.oid), tree: objectPath(copyRoot, apiTree.oid),
      blob: objectPath(copyRoot, blobs.get('src/api/controller.ts')!.oid) } };
};
