import { invokeAmaranthApi } from '@/app/api/apiProxy/apiProxy.js';
import { ForeignKeyMetadata, TableLookup, TableMetadata } from '@/domain/types';
import { MetadataEnricher } from './metadata-enricher';

export interface ProxyBatchConfig {
  domain: string;
  urlPath: string;
  token: string;
  hashKey: string;
  toolName: string;
  callerName?: string;
  groupSeq?: string;
  schemaName?: string;
}

type ProxyColumn = {
  name?: string;
};

type ProxyForeignKey = {
  column?: string;
  referencesTable?: string;
  referencesColumn?: string;
};

type ProxyTableData = {
  columns?: ProxyColumn[];
  primaryKeys?: string[];
  indexes?: string[];
  foreignKeys?: ProxyForeignKey[];
};

type ProxyResponse = {
  resultCode?: number;
  resultMsg?: string;
  resultData?: Record<string, ProxyTableData>;
};

type ProxyRequestTable = {
  tableName: string;
  schemaName?: string;
};

export class ProxyBatchMetadataEnricher implements MetadataEnricher {
  constructor(private readonly config: ProxyBatchConfig) {}

  async enrichTables(tables: TableLookup[]): Promise<Map<string, TableMetadata>> {
    if (tables.length === 0) {
      return new Map();
    }

    try {
      const requestTables = this.buildRequestTables(tables);
      const parameters = {
        toolName: this.config.toolName,
        tables: requestTables,
        ...(this.config.groupSeq ? { groupSeq: this.config.groupSeq } : {}),
      };

      const response = (await invokeAmaranthApi(
        'POST',
        this.config.domain,
        this.config.urlPath,
        JSON.stringify(parameters),
        this.config.token,
        this.config.hashKey,
        this.config.callerName ?? null,
        this.config.groupSeq ?? null,
      )) as ProxyResponse;

      return this.buildMetadataMap(tables, response);
    } catch (error) {
      console.error('[ProxyBatchMetadataEnricher] metadata fetch failed:', error);
      return new Map(tables.map((table) => [table.fullName, this.createEmptyMetadata(table)] as const));
    }
  }

  private buildRequestTables(tables: TableLookup[]): ProxyRequestTable[] {
    return tables.map((table) => ({
      tableName: table.tableName,
      schemaName: this.config.schemaName ?? table.schemaName,
    }));
  }

  private buildMetadataMap(tables: TableLookup[], response: ProxyResponse): Map<string, TableMetadata> {
    const resultData = response.resultData ?? {};
    const normalizedResult = new Map<string, ProxyTableData>();

    for (const [tableName, metadata] of Object.entries(resultData)) {
      normalizedResult.set(tableName.toLowerCase(), metadata);
    }

    const entries = tables.map((table) => {
      const proxyData = normalizedResult.get(table.tableName.toLowerCase());
      if (!proxyData) {
        return [table.fullName, this.createEmptyMetadata(table)] as const;
      }

      const columns = this.uniqueStrings(
        (proxyData.columns ?? [])
          .map((column) => (typeof column?.name === 'string' ? column.name.trim() : ''))
          .filter((name) => name.length > 0),
      );

      const primaryKeys = this.uniqueStrings(proxyData.primaryKeys ?? []);
      const indexes = this.uniqueStrings(proxyData.indexes ?? []);
      const foreignKeys = this.normalizeForeignKeys(proxyData.foreignKeys ?? []);

      return [
        table.fullName,
        {
          fullName: table.fullName,
          tableName: table.tableName,
          schemaName: table.schemaName,
          columns,
          primaryKeys,
          indexes,
          foreignKeys,
        },
      ] as const;
    });

    return new Map(entries);
  }

  private uniqueStrings(values: string[]): string[] {
    const deduped = new Map<string, string>();

    for (const value of values) {
      const normalized = value.trim();
      if (!normalized) {
        continue;
      }

      const key = normalized.toLowerCase();
      if (!deduped.has(key)) {
        deduped.set(key, normalized);
      }
    }

    return [...deduped.values()];
  }

  private normalizeForeignKeys(rawForeignKeys: ProxyForeignKey[]): ForeignKeyMetadata[] {
    const normalized: ForeignKeyMetadata[] = [];

    for (const foreignKey of rawForeignKeys) {
      const column = typeof foreignKey.column === 'string' ? foreignKey.column.trim() : '';
      const referencesTable =
        typeof foreignKey.referencesTable === 'string' ? foreignKey.referencesTable.trim() : '';
      const referencesColumn =
        typeof foreignKey.referencesColumn === 'string' ? foreignKey.referencesColumn.trim() : '';

      if (!column || !referencesTable || !referencesColumn) {
        continue;
      }

      normalized.push({
        column,
        referencesTable,
        referencesColumn,
      });
    }

    return normalized;
  }

  private createEmptyMetadata(table: TableLookup): TableMetadata {
    return {
      fullName: table.fullName,
      tableName: table.tableName,
      schemaName: table.schemaName,
      columns: [],
      primaryKeys: [],
      indexes: [],
      foreignKeys: [],
    };
  }
}
