import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type AnchorIdl, rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

const idlPath = resolve(import.meta.dirname, '../../target/idl/tender.json');
const packageFolder = import.meta.dirname;

const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as AnchorIdl;
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(packageFolder, {
    generatedFolder: 'src/generated',
    deleteFolderBeforeRendering: true,
  }),
);

console.log(`✓ generated kit-flavored client at ${packageFolder}/src/generated`);
