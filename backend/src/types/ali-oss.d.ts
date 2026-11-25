/**
 * ali-oss 没有随包提供类型声明（@types/ali-oss 版本陈旧且不完整），
 * 这里按本项目实际用到的方法补一份最小声明。
 */
declare module 'ali-oss' {
  interface OSSOptions {
    region: string;
    /** 可选自定义接入地址（内网 endpoint、自定义域名）；不填则由 region + bucket 推导。 */
    endpoint?: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
    secure?: boolean;
    timeout?: number;
    retryMax?: number;
  }

  interface PutOptions {
    headers?: Record<string, string>;
  }

  interface MultipartUploadOptions extends PutOptions {
    parallel?: number;
    partSize?: number;
  }

  interface GetResult {
    content: Buffer | string;
    res: { status: number; headers: Record<string, string> };
  }

  interface GetOptions {
    timeout?: number;
    headers?: Record<string, string>;
    process?: string;
  }

  interface HeadResult {
    res: { status: number; headers: Record<string, string> };
  }

  interface ListQuery {
    prefix?: string;
    marker?: string;
    delimiter?: string;
    'max-keys'?: number;
  }

  interface ListResult {
    objects: { name: string; url: string }[] | null;
    prefixes: string[] | null;
    nextMarker: string | null;
    isTruncated: boolean;
  }

  export default class OSS {
    constructor(options: OSSOptions);
    put(
      name: string,
      content: Buffer | string,
      options?: PutOptions,
    ): Promise<{ name: string; url: string; res: { status: number } }>;
    putStream(
      name: string,
      stream: import('node:stream').Readable,
      options?: PutOptions & { contentLength?: number; mime?: string; method?: string },
    ): Promise<{ name: string; url: string; res: { status: number } }>;
    multipartUpload(
      name: string,
      file: string,
      options?: MultipartUploadOptions,
    ): Promise<{ name: string; res: { status: number } }>;
    get(name: string, options?: GetOptions): Promise<GetResult>;
    head(name: string, options?: { timeout?: number }): Promise<HeadResult>;
    delete(name: string): Promise<{ res: { status: number } }>;
    list(query: ListQuery, options?: unknown): Promise<ListResult>;
    signatureUrl(
      name: string,
      options?: { expires?: number; method?: string; 'Content-Type'?: string; process?: string },
    ): string;
  }
}
