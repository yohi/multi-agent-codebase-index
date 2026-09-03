import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { afterAll, bench, describe } from 'vitest';

import { PathSanitizer } from '../../src/server/path-sanitizer.js';
import { SymbolRetrievalService } from '../../src/structured/retrieval-service.js';
import { createGenerationId, createSymbolId } from '../../src/structured/identity.js';
import { sha256Hex } from '../../src/structured/hash.js';
import {
  createStructuredCoordinatorFixture,
  createStructuredSource,
} from '../shared/structured-test-helpers.js';

const DECLARATION_COUNTS = [10, 50, 100] as const;

const buildFile = (declarationCount: number): {
  filePath: string;
  text: string;
  symbolIds: string[];
  generationId: string;
  contentHash: string;
  declarationSpans: Array<{ startByte: number; endByte: number; text: string }>;
} => {
  const filePath = 'src/module.ts';
  const declarations: string[] = [];
  const symbolIds: string[] = [];
  const declarationSpans: Array<{ startByte: number; endByte: number; text: string }> = [];
  let offset = 0;
  for (let i = 0; i < declarationCount; i += 1) {
    const name = `fn_${i}`;
    const text = `export function ${name}(x: number): number { return x + ${i}; }`;
    declarations.push(text);
    symbolIds.push(
      createSymbolId({
        filePath,
        qualifiedName: name,
        kind: 'function',
        signatureDiscriminator: '(x: number): number',
        occurrence: 0,
      }),
    );
    const startByte = offset;
    const endByte = offset + Buffer.byteLength(text, 'utf8');
    declarationSpans.push({ startByte, endByte, text });
    offset = endByte + 1;
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
  return { filePath, text, symbolIds, generationId, contentHash, declarationSpans };
};

interface CatalogFixture {
  projectRoot: string;
  service: SymbolRetrievalService;
  symbolIds: string[];
}

const catalogFixtures = new Map<number, CatalogFixture>();

const withCatalogSetup = async (declarationCount: number): Promise<CatalogFixture> => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-structured-bench-'));
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  const { metadataStore, coordinator } = await createStructuredCoordinatorFixture({
    bootstrapStructuredSchema: true,
  });
  const sanitizer = await PathSanitizer.create(projectRoot);
  const service = new SymbolRetrievalService({ catalog: metadataStore, sanitizer });

  const file = buildFile(declarationCount);
  await writeFile(path.join(projectRoot, file.filePath), file.text);
  const source = createStructuredSource(file.filePath, file.text);

  await coordinator.stageFile({
    source,
    generationId: file.generationId,
    contentHash: file.contentHash,
    fileCompleteness: 'complete',
    declarations: file.symbolIds.map((symbolId, index) => {
      const span = file.declarationSpans[index];
      if (span === undefined) {
        throw new Error(`missing declaration span ${index} in fixture`);
      }
      const line = index + 1;
      return {
        name: `fn_${index}`,
        symbolId,
        qualifiedName: `fn_${index}`,
        kind: 'function' as const,
        signatureDiscriminator: '(x: number): number',
        position: { startLine: line, startColumn: 0, endLine: line, endColumn: span.text.length },
        startByte: span.startByte,
        endByte: span.endByte,
        sourceHash: sha256Hex(source.bytes.subarray(span.startByte, span.endByte)),
        languageId: 'typescript',
        isExact: true,
      };
    }),
    imports: [],
    parserId: 'typescript',
    parserVersion: '1.0.0',
  });
  await coordinator.activateFile({ filePath: file.filePath, generationId: file.generationId });

  return { projectRoot, service, symbolIds: file.symbolIds };
};

for (const declarationCount of DECLARATION_COUNTS) {
  describe(`structured retrieval (${declarationCount} declarations)`, () => {
    afterAll(async () => {
      const fixture = catalogFixtures.get(declarationCount);
      if (fixture !== undefined) {
        await rm(fixture.projectRoot, { recursive: true, force: true });
      }
    });

    bench(
      'get_file_outline',
      async () => {
        const fixture = catalogFixtures.get(declarationCount);
        if (fixture === undefined) throw new Error('fixture not initialized');
        await fixture.service.getFileOutline({ filePath: 'src/module.ts' });
      },
      {
        iterations: 10,
        setup: async () => {
          if (!catalogFixtures.has(declarationCount)) {
            catalogFixtures.set(declarationCount, await withCatalogSetup(declarationCount));
          }
        },
      },
    );

    bench(
      'get_symbol_source',
      async () => {
        const fixture = catalogFixtures.get(declarationCount);
        if (fixture === undefined) throw new Error('fixture not initialized');
        const symbolId = fixture.symbolIds[Math.floor(fixture.symbolIds.length / 2)];
        if (symbolId === undefined) {
          throw new Error('fixture has no symbol ids');
        }
        await fixture.service.getSymbolSource({ symbolId });
      },
      {
        iterations: 10,
        setup: async () => {
          if (!catalogFixtures.has(declarationCount)) {
            catalogFixtures.set(declarationCount, await withCatalogSetup(declarationCount));
          }
        },
      },
    );

    bench(
      'get_symbol_context',
      async () => {
        const fixture = catalogFixtures.get(declarationCount);
        if (fixture === undefined) throw new Error('fixture not initialized');
        const symbolId = fixture.symbolIds[Math.floor(fixture.symbolIds.length / 2)];
        if (symbolId === undefined) {
          throw new Error('fixture has no symbol ids');
        }
        await fixture.service.getSymbolContext({
          symbolId,
          tokenBudget: 1000,
        });
      },
      {
        iterations: 10,
        setup: async () => {
          if (!catalogFixtures.has(declarationCount)) {
            catalogFixtures.set(declarationCount, await withCatalogSetup(declarationCount));
          }
        },
      },
    );
  });
}
