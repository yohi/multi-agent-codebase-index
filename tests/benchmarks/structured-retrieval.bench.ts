import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { bench, describe } from 'vitest';

import { PathSanitizer } from '../../src/server/path-sanitizer.js';
import { SymbolRetrievalService } from '../../src/structured/retrieval-service.js';
import { createGenerationId, createSymbolId } from '../../src/structured/identity.js';
import { sha256Hex } from '../../src/structured/hash.js';
import {
  createStructuredCoordinatorFixture,
  createStructuredSource,
} from '../shared/structured-test-helpers.js';

const DECLARATION_COUNTS = [10, 50, 100] as const;

const buildFile = (declarationCount: number): { filePath: string; text: string; symbolIds: string[]; generationId: string; contentHash: string } => {
  const filePath = 'src/module.ts';
  const declarations: string[] = [];
  const symbolIds: string[] = [];
  for (let i = 0; i < declarationCount; i += 1) {
    const name = `fn_${i}`;
    declarations.push(`export function ${name}(x: number): number { return x + ${i}; }`);
    symbolIds.push(
      createSymbolId({
        filePath,
        qualifiedName: name,
        kind: 'function',
        signatureDiscriminator: '(x: number): number',
        occurrence: 0,
      }),
    );
  }
  const text = declarations.join('\n');
  const bytes = Buffer.from(text, 'utf8');
  const contentHash = sha256Hex(bytes);
  const generationId = createGenerationId({
    schemaVersion: 1,
    parserId: 'typescript',
    parserVersion: '1.0.0',
    contentHash,
  });
  return { filePath, text, symbolIds, generationId, contentHash };
};

const withCatalog = async <T>(
  declarationCount: number,
  run: (service: SymbolRetrievalService, symbolIds: string[]) => Promise<T>,
): Promise<T> => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-structured-bench-'));
  try {
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    const { metadataStore, coordinator } = await createStructuredCoordinatorFixture({
      bootstrapStructuredSchema: true,
    });
    const sanitizer = await PathSanitizer.create(projectRoot);
    const service = new SymbolRetrievalService({ catalog: metadataStore, sanitizer });

    const file = buildFile(declarationCount);
    await writeFile(path.join(projectRoot, file.filePath), file.text);
    const lines = file.text.split('\n');
    const source = createStructuredSource(file.filePath, file.text);

    await coordinator.stageFile({
      source,
      generationId: file.generationId,
      contentHash: file.contentHash,
      fileCompleteness: 'complete',
      declarations: file.symbolIds.map((symbolId, index) => {
        const lineText = lines[index];
        if (lineText === undefined) {
          throw new Error(`missing line ${index} in fixture`);
        }
        const line = index + 1;
        return {
          name: `fn_${index}`,
            symbolId,
            qualifiedName: `fn_${index}`,
            kind: 'function' as const,
            signatureDiscriminator: '(x: number): number',
            position: { startLine: line, startColumn: 0, endLine: line, endColumn: lineText.length },
          startByte: 0,
          endByte: source.bytes.length,
          sourceHash: file.contentHash,
          languageId: 'typescript',
          isExact: true,
        };
      }),
      imports: [],
      parserId: 'typescript',
      parserVersion: '1.0.0',
    });
    await coordinator.activateFile({ filePath: file.filePath, generationId: file.generationId });

    return await run(service, file.symbolIds);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};

for (const declarationCount of DECLARATION_COUNTS) {
  describe(`structured retrieval (${declarationCount} declarations)`, () => {
    bench(
      'get_file_outline',
      async () => {
        await withCatalog(declarationCount, async (service) => {
          await service.getFileOutline({ filePath: 'src/module.ts' });
        });
      },
      { iterations: 10 },
    );

    bench(
      'get_symbol_source',
      async () => {
        await withCatalog(declarationCount, async (service, symbolIds) => {
          const symbolId = symbolIds[Math.floor(symbolIds.length / 2)];
          if (symbolId === undefined) {
            throw new Error('fixture has no symbol ids');
          }
          await service.getSymbolSource({ symbolId });
        });
      },
      { iterations: 10 },
    );

    bench(
      'get_symbol_context',
      async () => {
        await withCatalog(declarationCount, async (service, symbolIds) => {
          const symbolId = symbolIds[Math.floor(symbolIds.length / 2)];
          if (symbolId === undefined) {
            throw new Error('fixture has no symbol ids');
          }
          await service.getSymbolContext({
            symbolId,
            tokenBudget: 1000,
          });
        });
      },
      { iterations: 10 },
    );
  });
}
