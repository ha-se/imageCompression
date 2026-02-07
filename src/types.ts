export interface KintoneFileInfo {
  contentType: string;
  fileKey: string;
  name: string;
  size: string; // Kintone returns size as string
}

export interface KintoneRecord {
  $id: { type: "RECORD_NUMBER"; value: string };
  [fieldCode: string]: { type: string; value: unknown };
}

export interface KintoneGetRecordsResponse {
  records: KintoneRecord[];
  totalCount: string | null;
}

export interface KintoneUploadResponse {
  fileKey: string;
}

export interface CompressResult {
  originalSize: number;
  compressedSize: number;
  originalName: string;
  newName: string;
}

export interface ProcessResult {
  recordId: string;
  files: CompressResult[];
  skipped: number;
  errors: string[];
}

export interface DeleteResult {
  recordId: string;
  deletedFiles: string[];
  keptFiles: string[];
  error?: string;
}

export interface Config {
  baseUrl: string;
  apiToken: string;
  appId: string;
  attachmentFields: string[];
  maxFileSizeMB: number;
  targetQuality: number;
  retentionMonths: number;
  enableDeleteOldImages: boolean;
  maxApiCalls: number;
  batchSize: number;
}
