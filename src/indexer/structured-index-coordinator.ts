import type { IVectorStore } from '../types/index.js';
import type { Chunker } from './chunker.js';
import type { IStructuredCatalog, StructuredGenerationStage, StructuredGenerationActivation, StructuredFileRetirement } from '../storage/interfaces/structured-catalog.js';
import type { ProjectWriteCoordinator } from './project-write-coordinator.js';
import type { StructuredDeclaration, StructuredImport, StructuredSource } from '../structured/contracts.js';

export interface StructuredIndexCoordinatorOptions {
  metadataStore: IStructuredCatalog;
  vectorStore: IVectorStore;
  chunker: Chunker;
  projectWriteCoordinator: ProjectWriteCoordinator;
}

export class StructuredIndexCoordinator {
  constructor(private readonly options: StructuredIndexCoordinatorOptions) {}

  async stageFile(input: {
    source: StructuredSource;
    generationId: string;
    contentHash: string;
    fileCompleteness: 'complete' | 'partial';
    declarations: StructuredDeclaration[];
    imports: StructuredImport[];
    parserId?: string;
    parserVersion?: string;
  }): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      const state = await this.options.metadataStore.getStructuredIndexState();
      const expectedActiveGeneration = state.activeGenerations.get(input.source.filePath) ?? null;
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
          bytes: input.source.bytes,
        },
        {
          declarations: input.declarations,
          imports: input.imports,
        },
      );

      // Placeholder embeddings: real pipeline will compute embeddings before staging.
      const embeddings = chunks.map(() => new Array<number>(64).fill(0));

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
          expectedActiveGeneration,
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

      if (expectedActiveGeneration !== null) {
        await this.options.vectorStore.removeGenerationRows(input.filePath, expectedActiveGeneration);
      }
      await this.options.vectorStore.deleteByFilePath(input.filePath);
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
