import { TableLookup, TableMetadata } from '../domain/types';

export interface MetadataEnricher {
  enrichTables(tables: TableLookup[]): Promise<Map<string, TableMetadata>>;
}

