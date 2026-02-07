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

  constructor(config: Config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiToken = config.apiToken;
    this.appId = config.appId;
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

  async getRecords(
    query: string,
    fields: string[],
    offset = 0,
    limit = 500
  ): Promise<KintoneGetRecordsResponse> {
    const params = new URLSearchParams({
      app: this.appId,
      query: `${query} limit ${limit} offset ${offset}`,
    });
    for (const f of fields) {
      params.append("fields[]", f);
    }

    const res = await fetch(
      `${this.baseUrl}/k/v1/records.json?${params.toString()}`,
      { headers: this.headers() }
    );

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
    let offset = 0;
    const limit = 500;

    while (true) {
      const res = await this.getRecords(query, fields, offset, limit);
      all.push(...res.records);
      if (res.records.length < limit) break;
      offset += limit;
    }

    return all;
  }

  async downloadFile(fileKey: string): Promise<Buffer> {
    const params = new URLSearchParams({ fileKey });
    const res = await fetch(
      `${this.baseUrl}/k/v1/file.json?${params.toString()}`,
      { headers: this.headers() }
    );

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
