declare module '@/app/api/apiProxy/apiProxy.js' {
  export function invokeAmaranthApi(
    method: string,
    domain: string,
    urlPath: string,
    parameters: string | null,
    token: string,
    hashKey: string,
    callerName?: string | null,
    groupSeq?: string | null,
  ): Promise<unknown>;

  export default invokeAmaranthApi;
}
