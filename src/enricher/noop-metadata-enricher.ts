import { TableLookup, TableMetadata } from '../domain/types';
import { MetadataEnricher } from './metadata-enricher';

export class NoopMetadataEnricher implements MetadataEnricher {
  async enrichTables(tables: TableLookup[]): Promise<Map<string, TableMetadata>> {
    return new Map(
      tables.map((table) => [
        table.fullName,
        {
          ...table,
          columns: [],
          primaryKeys: [],
          indexes: [],
          foreignKeys: [],
        },
      ]),
    );
  }
}

