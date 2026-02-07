import type { ApiCounter } from "./api-counter.js";
import type {
  Config,
  KintoneFileInfo,
  KintoneGetRecordsResponse,
  KintoneRecord,
  KintoneUploadResponse,
} from "./types.js";

export class KintoneClient {
  private baseUrl: string;
  private apiToken: string;
  private appId: string;
  private apiCounter?: ApiCounter;

  constructor(config: Config, apiCounter?: ApiCounter) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiToken = config.apiToken;
    this.appId = config.appId;
    this.apiCounter = apiCounter;
  }

  private headers(contentType?: string): Record<string, string> {
    const h: Record<string, string> = {
      "X-Cybozu-API-Token": this.apiToken,
    };
    if (contentType) {
      h["Content-Type"] = contentType;
    }
    return h;
  }

  private async fetchRecords(
    query: string,
    fields: string[]
  ): Promise<KintoneGetRecordsResponse> {
    const params = new URLSearchParams({
      app: this.appId,
      query,
    });
    for (const f of fields) {
      params.append("fields[]", f);
    }

    const res = await fetch(
      `${this.baseUrl}/k/v1/records.json?${params.toString()}`,
      { headers: this.headers() }
    );
    this.apiCounter?.increment();

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to get records: ${res.status} ${body}`);
    }

    return (await res.json()) as KintoneGetRecordsResponse;
  }

  async getAllRecords(
    query: string,
    fields: string[]
  ): Promise<KintoneRecord[]> {
    const all: KintoneRecord[] = [];
    let lastId = "0";
    const limit = 500;

    // fieldsに$idが含まれていない場合は追加
    const fieldsWithId = fields.includes("$id")
      ? fields
      : ["$id", ...fields];

    while (true) {
      // $idベースのカーソルページネーション（offset上限10,000を回避）
      const idCondition = `$id > "${lastId}"`;
      const fullQuery = query
        ? `${idCondition} and (${query}) order by $id asc limit ${limit}`
        : `${idCondition} order by $id asc limit ${limit}`;

      const res = await this.fetchRecords(fullQuery, fieldsWithId);
      all.push(...res.records);
      if (res.records.length < limit) break;

      lastId = res.records[res.records.length - 1].$id.value;
    }

    return all;
  }

  async downloadFile(fileKey: string): Promise<Buffer> {
    const params = new URLSearchParams({ fileKey });
    const res = await fetch(
      `${this.baseUrl}/k/v1/file.json?${params.toString()}`,
      { headers: this.headers() }
    );
    this.apiCounter?.increment();

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to download file: ${res.status} ${body}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  async uploadFile(
    fileName: string,
    data: Buffer
  ): Promise<KintoneUploadResponse> {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(data)]);
    formData.append("file", blob, fileName);

    const res = await fetch(`${this.baseUrl}/k/v1/file.json`, {
      method: "POST",
      headers: {
        "X-Cybozu-API-Token": this.apiToken,
      },
      body: formData,
    });
    this.apiCounter?.increment();

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to upload file: ${res.status} ${body}`);
    }

    return (await res.json()) as KintoneUploadResponse;
  }

  async updateRecord(
    recordId: string,
    fieldCode: string,
    fileInfos: Array<{ fileKey: string }>
  ): Promise<void> {
    const body = {
      app: this.appId,
      id: recordId,
      record: {
        [fieldCode]: {
          value: fileInfos,
        },
      },
    };

    const res = await fetch(`${this.baseUrl}/k/v1/record.json`, {
      method: "PUT",
      headers: this.headers("application/json"),
      body: JSON.stringify(body),
    });
    this.apiCounter?.increment();

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to update record: ${res.status} ${text}`);
    }
  }

  static extractFiles(
    record: KintoneRecord,
    fieldCode: string
  ): KintoneFileInfo[] {
    const field = record[fieldCode];
    if (!field || !Array.isArray(field.value)) return [];
    return field.value as KintoneFileInfo[];
  }
}
