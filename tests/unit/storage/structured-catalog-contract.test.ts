import { structuredCatalogContract } from '../../shared/structured-catalog-contract.js';
import { InMemoryMetadataStore } from './in-memory-metadata-store.js';

structuredCatalogContract(async () => new InMemoryMetadataStore());
