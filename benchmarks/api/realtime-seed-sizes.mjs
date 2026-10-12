// Read-only seed-content analysis; never imports the seeder or opens a database connection.
// node benchmarks/api/realtime-seed-sizes.mjs [output directory]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, constants } from 'node:zlib';
import ts from 'typescript';

const api = createRequire(new URL('../../apps/api/package.json', import.meta.url));
api('tsx/cjs/api').register();
const templates = api('@kanera/shared/workspace-templates');
const { compactWireCard } = api('@kanera/shared/events');
const sourcePath = fileURLToPath(new URL('../../apps/api/src/scripts/seed-data.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
// Only function declarations enter the VM. No seeder imports, top-level initializers, or seedDatabase
// invocation run. buildWorkspaceSeeds is the inspected pure builder used by the real seeder.
const declarations = ast.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(ast)).join('\n');
const code = ts.transpileModule(declarations.replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const workspaces = runInNewContext(`${code}; buildWorkspaceSeeds()`, templates, { timeout: 5000 });
const cards = workspaces.flatMap(workspace => workspace.boards.flatMap(board => board.cards));
const notes = [];
function collectNotes(items = []) {
  for (const note of items) { notes.push(note); collectNotes(note.children); }
}
for (const workspace of workspaces) {
  collectNotes(workspace.notes);
  for (const board of workspace.boards) collectNotes(board.notes);
}
const comments = cards.flatMap(card => card.comments ?? []);
const id = '00000000-0000-4000-8000-000000000001';
const at = '2026-10-12T00:00:00.000Z';
// Text comes from the actual normalized seed builders. Generated entity metadata is representative,
// not captured from a running server. IDs/dates have real wire lengths; expanded media URLs and the
// seeder's subsequent internal-link additions are excluded. These are size estimates, not traffic rates.
const cardPackets = cards.map((card, index) => '42' + JSON.stringify(['card:updated', {
  boardId: id,
  card: compactWireCard({
    id, workspaceId: id, organisationKey: 'DEVELOPMENT', number: index + 1, key: `DEVELOPMENT-${index + 1}`,
    boardId: id, listId: id, title: card.title, description: card.description,
    position: '1024.0000000000', createdById: id, createdAt: at, updatedAt: at,
    ...(card.dueOffsetDays === undefined ? {} : { dueDateLocalDate: '2026-10-12', dueDateSlot: card.dueDateSlot ?? 'morning', dueDateTimezone: 'Asia/Kolkata' }),
    ...(card.completedBy ? { completedAt: at } : {}),
    ...(card.attachments?.length ? { coverAttachmentId: id } : {}),
  }),
}]));
const notePackets = notes.map(note => '42' + JSON.stringify(['note:updated', { note: {
  id, workspaceId: id, boardId: id, parentNoteId: null, scope: note.scope ?? 'team', ownerId: id,
  lastEditedById: id, lastEditedByName: 'Amelia Hart', lastEditedByAvatarUrl: '/api/media/avatar/example',
  lastEditedAt: at, title: note.title, content: note.content, icon: note.icon ?? 'file-text', color: null,
  position: '1024.0000000000', editingUserId: null, editingExpiresAt: null, createdAt: at, updatedAt: at,
} }]));

function sizes(values) {
  const sorted = values.map(value => Buffer.byteLength(value)).sort((a, b) => a - b);
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1] ?? 0;
  return {
    count: sorted.length, median: percentile(.5), p95: percentile(.95), max: sorted.at(-1) ?? 0,
    mean: sorted.reduce((sum, size) => sum + size, 0) / (sorted.length || 1),
    over1KiB: sorted.filter(size => size >= 1024).length,
    over4KiB: sorted.filter(size => size >= 4096).length,
  };
}
const tunedSizes = packets => sizes(packets.map(packet => Buffer.byteLength(packet) < 1024 ? packet :
  deflateRawSync(packet, { level: 1, flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH }).subarray(0, -4)));
const summary = {
  scope: 'Three main workspace builders (10 boards), including nested notes; excludes standalone/guest boards and scratchpads.',
  caveat: 'Text sizes are exact for these builders; event sizes use representative metadata and omit expanded media URLs/internal-link additions. Reused placeholder IDs can exaggerate compression savings. No production event frequency is inferred.',
  workspaces: workspaces.map(workspace => ({ name: workspace.name, boards: workspace.boards.length })),
  cards: sizes(cards.map(card => card.description)), notes: sizes(notes.map(note => note.content)),
  comments: sizes(comments.map(comment => comment.body)),
  cardEvents: sizes(cardPackets), noteEvents: sizes(notePackets),
  cardEventsCompressed: tunedSizes(cardPackets), noteEventsCompressed: tunedSizes(notePackets),
  largestNotes: notes.map(note => ({ title: note.title, bytes: Buffer.byteLength(note.content) })).sort((a, b) => b.bytes - a.bytes).slice(0, 5),
};
const output = process.argv[2] ?? fileURLToPath(new URL('results/realtime-seed-20261012/', import.meta.url));
mkdirSync(output, { recursive: true });
writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
