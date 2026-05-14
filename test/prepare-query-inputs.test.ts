import { prepareQueryInputs } from '../src/server/prepare-query-inputs';
import { analyzeQueries } from '../src/analyzer/analyze';
import { NoopMetadataEnricher } from '../src/enricher/noop-metadata-enricher';

describe('prepareQueryInputs', () => {
  it('splits multiple SQL statements and keeps only read queries', () => {
    const prepared = prepareQueryInputs('', [
      {
        name: 'multi.sql',
        content: `
          SELECT * FROM \${dbErp}.테이블A;
          UPDATE 테이블A SET name = 'x';
          WITH sample AS (SELECT * FROM \${dbErp}.테이블B) SELECT * FROM sample;
        `,
      },
    ]);

    expect(prepared.inputs).toEqual([
      {
        name: 'multi.sql#1',
        sql: 'SELECT * FROM ${dbErp}.테이블A',
        metadata: {
          documentName: 'multi.sql',
          sourceLabel: 'multi.sql#1',
          format: 'sql',
          queryId: undefined,
          tagName: undefined,
        },
      },
      {
        name: 'multi.sql#2',
        sql: 'WITH sample AS (SELECT * FROM ${dbErp}.테이블B) SELECT * FROM sample',
        metadata: {
          documentName: 'multi.sql',
          sourceLabel: 'multi.sql#2',
          format: 'sql',
          queryId: undefined,
          tagName: undefined,
        },
      },
    ]);
    expect(prepared.warnings).toContain('multi.sql에서 조회 이외의 쿼리 1개를 분석 대상에서 제외했습니다.');
  });

  it('extracts multiple MyBatis read queries and keeps their ids', () => {
    const prepared = prepareQueryInputs('', [
      {
        name: 'mapper.xml',
        content: `
          <mapper namespace="sample.Mapper">
            <select id="findOrders">
              SELECT * FROM \${dbErp}.주문;
            </select>
            <update id="updateOrder">
              UPDATE 주문 SET status = 'DONE';
            </update>
            <select id="findCustomers"><![CDATA[
              SELECT * FROM \${dbErp}.고객
            ]]></select>
          </mapper>
        `,
      },
    ]);

    expect(prepared.inputs).toEqual([
      {
        name: 'mapper.xml#findOrders',
        sql: 'SELECT * FROM ${dbErp}.주문',
        metadata: {
          documentName: 'mapper.xml',
          sourceLabel: 'mapper.xml#findOrders',
          format: 'xml',
          queryId: 'findOrders',
          tagName: 'select',
        },
      },
      {
        name: 'mapper.xml#findCustomers',
        sql: 'SELECT * FROM ${dbErp}.고객',
        metadata: {
          documentName: 'mapper.xml',
          sourceLabel: 'mapper.xml#findCustomers',
          format: 'xml',
          queryId: 'findCustomers',
          tagName: 'select',
        },
      },
    ]);
    expect(prepared.warnings).toContain('mapper.xml에서 조회 이외의 쿼리 1개를 분석 대상에서 제외했습니다.');
  });

  it('ignores non-read MyBatis tags for now', () => {
    const prepared = prepareQueryInputs('', [
      {
        name: 'writer.xml',
        content: `
          <mapper namespace="sample.WriterMapper">
            <insert id="createOrder">
              INSERT INTO 주문(id) VALUES (1);
            </insert>
            <update id="updateOrder">
              UPDATE 주문 SET status = 'DONE';
            </update>
            <delete id="deleteOrder">
              DELETE FROM 주문 WHERE id = 1;
            </delete>
          </mapper>
        `,
      },
    ]);

    expect(prepared.inputs).toEqual([]);
    expect(prepared.warnings).toEqual([
      'writer.xml에서 조회 이외의 쿼리 3개를 분석 대상에서 제외했습니다.',
      'writer.xml에는 조회 계열 쿼리가 없어 분석하지 않았습니다.',
    ]);
  });

  it('surfaces selected MyBatis query ids in the final analysis response', async () => {
    const prepared = prepareQueryInputs('', [
      {
        name: 'mapper.xml',
        content: `
          <mapper namespace="sample.Mapper">
            <select id="findOrders">
              SELECT * FROM \${DB_ERP}.주문;
            </select>
            <select id="findOrderItems">
              SELECT * FROM #{schema}.주문상세;
            </select>
          </mapper>
        `,
      },
    ]);

    const result = await analyzeQueries(prepared.inputs, new NoopMetadataEnricher(), {
      extraWarnings: prepared.warnings,
    });

    expect(result.acceptedQuerySources).toEqual([
      {
        sourceName: 'mapper.xml#findOrders',
        documentName: 'mapper.xml',
        sourceLabel: 'mapper.xml#findOrders',
        format: 'xml',
        queryId: 'findOrders',
        tagName: 'select',
      },
      {
        sourceName: 'mapper.xml#findOrderItems',
        documentName: 'mapper.xml',
        sourceLabel: 'mapper.xml#findOrderItems',
        format: 'xml',
        queryId: 'findOrderItems',
        tagName: 'select',
      },
    ]);
    expect(result.parsedQueries.map((query) => query.metadata?.queryId)).toEqual(['findOrders', 'findOrderItems']);
  });
});
