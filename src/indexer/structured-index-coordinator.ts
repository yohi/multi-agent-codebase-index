import type { IVectorStore } from '../types/index.js';
import type { Chunker } from './chunker.js';
import type { IStructuredCatalog, StructuredGenerationStage, StructuredGenerationActivation, StructuredFileRetirement } from '../storage/interfaces/structured-catalog.js';
import type { ProjectWriteCoordinator } from './project-write-coordinator.js';

export interface FullRebuildFile {
  source: import('../structured/contracts.js').StructuredSource;
  generationId: string;
  contentHash: string;
  fileCompleteness: 'complete' | 'partial';
  declarations: import('../structured/contracts.js').StructuredDeclaration[];
  imports: import('../structured/contracts.js').StructuredImport[];
}

export interface StructuredIndexCoordinatorOptions {
  metadataStore: IStructuredCatalog;
  vectorStore: IVectorStore;
  chunker: Chunker;
  projectWriteCoordinator: ProjectWriteCoordinator;
}

export class StructuredIndexCoordinator {
  constructor(private readonly options: StructuredIndexCoordinatorOptions) {}

  async stageFile(input: {
    source: import('../structured/contracts.js').StructuredSource;
    generationId: string;
    contentHash: string;
    fileCompleteness: 'complete' | 'partial';
    declarations: import('../structured/contracts.js').StructuredDeclaration[];
    imports: import('../structured/contracts.js').StructuredImport[];
    parserId?: string;
    parserVersion?: string;
  }): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      const rebuildEpoch = Date.now();
      const stage: StructuredGenerationStage = {
        filePath: input.source.filePath,
        generation: {
          generationId: input.generationId,
          schemaVersion: 1,
          parserId: input.parserId ?? 'unknown',
          parserVersion: input.parserVersion ?? '0',
          fileHash: input.contentHash,
          fileCompleteness: input.fileCompleteness,
        },
        declarations: input.declarations,
        imports: input.imports,
        rebuildEpoch,
        bytes: input.source.bytes,
        fileHash: input.contentHash,
        fileCompleteness: input.fileCompleteness,
      };

      await this.options.metadataStore.stageGeneration(stage);

      const chunks = await this.options.chunker.chunkStructuredFile(
        {
          filePath: input.source.filePath,
          language: input.source.language,
          content: input.source.text,
        },
        {
          declarations: input.declarations,
          imports: input.imports,
        },
      );

      // Placeholder embeddings: real pipeline will compute embeddings before staging.
      const embeddings = chunks.map(() => new Array(64).fill(0));

      try {
        await this.options.vectorStore.stageGenerationChunks({
          filePath: input.source.filePath,
          generationId: input.generationId,
          chunks,
          vectors: embeddings,
        });
      } catch (error) {
        await this.options.metadataStore.clearPendingGeneration({
          filePath: input.source.filePath,
          expectedActiveGeneration: null,
          expectedPendingGeneration: input.generationId,
          expectedRebuildEpoch: rebuildEpoch,
        });
        throw error;
      }
    });
  }

  async activateFile(input: { filePath: string; generationId: string }): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      const state = await this.options.metadataStore.getStructuredIndexState();
      const activeGenerations = state.activeGenerations;
      const expectedActiveGeneration = activeGenerations.get(input.filePath) ?? null;

      const activation: StructuredGenerationActivation = {
        filePath: input.filePath,
        generationId: input.generationId,
        expectedActiveGeneration,
        expectedRebuildEpoch: state.rebuildEpoch,
      };

      const result = await this.options.metadataStore.activateGeneration(activation);
      if (!result.activated) {
        return;
      }

      await this.options.vectorStore.activateGenerationRows(input.filePath, input.generationId);

      if (expectedActiveGeneration !== null) {
        await this.options.vectorStore.removeGenerationRows(input.filePath, expectedActiveGeneration);
      }
    });
  }

  async deleteFile(input: { filePath: string }): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      const state = await this.options.metadataStore.getStructuredIndexState();
      const activeGenerations = state.activeGenerations;
      const expectedActiveGeneration = activeGenerations.get(input.filePath) ?? null;

      const retirement: StructuredFileRetirement = {
        filePath: input.filePath,
        expectedActiveGeneration,
        rebuildEpoch: state.rebuildEpoch,
      };

      await this.options.metadataStore.retireFile(retirement);

      await this.options.vectorStore.deleteByFilePath(input.filePath);
    });
  }

  async runFullRebuild(input: { files: FullRebuildFile[] }): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      await this.options.metadataStore.bootstrapStructuredSchema();
      const epoch = await this.options.metadataStore.incrementRebuildEpoch();
      await this.options.metadataStore.setStructuredRebuildState({ rebuildState: 'building' });

      const shadowTable = await this.options.vectorStore.beginStructuredShadowTable();
      try {
        for (const file of input.files) {
          const stage: StructuredGenerationStage = {
            filePath: file.source.filePath,
            generation: {
              generationId: file.generationId,
              schemaVersion: 1,
              parserId: 'full-rebuild',
              parserVersion: '1',
              fileHash: file.contentHash,
              fileCompleteness: file.fileCompleteness,
            },
            declarations: file.declarations,
            imports: file.imports,
            rebuildEpoch: epoch,
            bytes: file.source.bytes,
            fileHash: file.contentHash,
            fileCompleteness: file.fileCompleteness,
          };
          await this.options.metadataStore.stageGeneration(stage);

          const chunks = await this.options.chunker.chunkStructuredFile(
            {
              filePath: file.source.filePath,
              language: file.source.language,
              content: file.source.text,
            },
            { declarations: file.declarations, imports: file.imports },
          );
          const embeddings = chunks.map(() => new Array(64).fill(0));
          await this.options.vectorStore.stageGenerationChunks({
            filePath: file.source.filePath,
            generationId: file.generationId,
            chunks,
            vectors: embeddings,
          });
        }

        await this.options.vectorStore.swapStructuredShadowTable(shadowTable);

        const state = await this.options.metadataStore.getStructuredIndexState();
        for (const file of input.files) {
          await this.options.metadataStore.activateGeneration({
            filePath: file.source.filePath,
            generationId: file.generationId,
            expectedActiveGeneration: state.activeGenerations.get(file.source.filePath) ?? null,
            expectedRebuildEpoch: epoch,
          });
        }
        await this.options.metadataStore.setStructuredRebuildState({ rebuildState: 'idle', lastErrorCode: null });
      } catch (error) {
        await this.options.vectorStore.abortStructuredShadowTable(shadowTable).catch(() => {});
        await this.options.metadataStore.setStructuredRebuildState({
          rebuildState: 'failed',
          lastErrorCode: error instanceof Error ? error.message : 'unknown',
        });
        throw error;
      }
    });
  }

  async reconcile(): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      const state = await this.options.metadataStore.getStructuredIndexState();
      const activeGenerations = Array.from(state.activeGenerations.entries()).map(
        ([filePath, generationId]) => ({ filePath, generationId }),
      );
      await this.options.vectorStore.reconcileStructuredRows(activeGenerations);
      await this.options.metadataStore.reconcileStructuredState();
    });
  }
}
