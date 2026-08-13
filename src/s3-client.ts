import { PutObjectCommand, S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import type { Config, KintoneFileInfo, KintoneRecord } from "./types.js";

interface ArchiveObjectParams {
  recordId: string;
  fieldCode: string;
  file: KintoneFileInfo;
  data: Buffer;
}

interface ArchiveRecordParams {
  recordId: string;
  record: KintoneRecord;
  archivedAt: string;
  archivedImages: ArchivedImageInfo[];
}

export interface ArchivedImageInfo {
  fieldCode: string;
  originalFileName: string;
  originalFileKey: string;
  contentType: string;
  size: string;
  bucket: string;
  key: string;
  s3Uri: string;
}

export class S3ArchiveClient {
  private client: AwsS3Client;
  private bucket: string;
  private prefix: string;
  private appId: string;

  constructor(config: Config) {
    this.client = new AwsS3Client({ region: config.awsRegion });
    this.bucket = config.s3Bucket;
    this.prefix = config.s3Prefix.replace(/^\/+|\/+$/g, "");
    this.appId = config.appId;
  }

  async uploadImage(params: ArchiveObjectParams): Promise<string> {
    const key = this.buildImageObjectKey(params);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: params.data,
        ContentType: params.file.contentType || "application/octet-stream",
        Metadata: {
          appId: this.appId,
          recordId: params.recordId,
          // S3メタデータはHTTPヘッダーに載るため、日本語などの非ASCII文字を
          // 含むフィールドコード（例: その他報告写真）はエンコードが必須。
          fieldCode: encodeURIComponent(params.fieldCode),
          originalFileName: encodeURIComponent(params.file.name),
          originalFileKey: params.file.fileKey,
        },
      })
    );

    return key;
  }

  async uploadRecordJson(params: ArchiveRecordParams): Promise<string> {
    const key = this.buildRecordJsonObjectKey(params.recordId);
    const body = JSON.stringify(
      {
        archivedAt: params.archivedAt,
        appId: this.appId,
        recordId: params.recordId,
        archivedImages: params.archivedImages,
        record: params.record,
      },
      null,
      2
    );

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from(body),
        ContentType: "application/json",
        Metadata: {
          appId: this.appId,
          recordId: params.recordId,
          archivedAt: params.archivedAt,
        },
      })
    );

    return key;
  }

  createS3Uri(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }

  getBucketName(): string {
    return this.bucket;
  }

  private buildImageObjectKey(params: ArchiveObjectParams): string {
    const safeFieldCode = sanitizePathSegment(params.fieldCode);
    const safeFileName = sanitizePathSegment(params.file.name);
    const fileKey = sanitizePathSegment(params.file.fileKey);
    const baseKey = [
      "kintone",
      `app-${this.appId}`,
      `record-${params.recordId}`,
      safeFieldCode,
      `${fileKey}-${safeFileName}`,
    ].join("/");

    return this.prefix ? `${this.prefix}/${baseKey}` : baseKey;
  }

  private buildRecordJsonObjectKey(recordId: string): string {
    const baseKey = [
      "kintone",
      `app-${this.appId}`,
      `record-${recordId}`,
      "record.json",
    ].join("/");

    return this.prefix ? `${this.prefix}/${baseKey}` : baseKey;
  }
}

function sanitizePathSegment(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\w.\-=]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
}
