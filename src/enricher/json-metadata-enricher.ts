import { readFile } from 'fs/promises';
import { TableLookup, TableMetadata } from '../domain/types';
import { MetadataEnricher } from './metadata-enricher';

type RawMetadataRecord = Record<string, Partial<TableMetadata>>;

export class JsonMetadataEnricher implements MetadataEnricher {
  private readonly metadataByKey: RawMetadataRecord;

  private constructor(metadataByKey: RawMetadataRecord) {
    this.metadataByKey = metadataByKey;
  }

  static async fromFile(path: string): Promise<JsonMetadataEnricher> {
    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content) as RawMetadataRecord;
    return new JsonMetadataEnricher(parsed);
  }

  async enrichTables(tables: TableLookup[]): Promise<Map<string, TableMetadata>> {
    const entries = tables.map((table) => {
      const rawMetadata = this.metadataByKey[table.fullName] ?? this.metadataByKey[table.tableName] ?? {};

      return [
        table.fullName,
        {
          fullName: table.fullName,
          tableName: table.tableName,
          schemaName: table.schemaName,
          columns: rawMetadata.columns ?? [],
          primaryKeys: rawMetadata.primaryKeys ?? [],
          indexes: rawMetadata.indexes ?? [],
          foreignKeys: rawMetadata.foreignKeys ?? [],
        },
      ] as const;
    });

    return new Map(entries);
  }
}

