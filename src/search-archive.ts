import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

interface ArchivedRecordJson {
  archivedAt: string;
  appId: string;
  recordId: string;
  archivedImages: Array<{
    fieldCode: string;
    originalFileName: string;
    s3Uri: string;
  }>;
  record: Record<string, { type: string; value: unknown }>;
}

interface SearchOptions {
  property?: string;
  from?: string;
  to?: string;
  propertyField: string;
  createdField: string;
}

function parseArgs(): SearchOptions {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  return {
    property: get("--property"),
    from: get("--from"),
    to: get("--to"),
    propertyField: get("--property-field") ?? "物件名kv",
    createdField: get("--created-field") ?? "作成日時",
  };
}

// @aws-sdk/client-s3 の GetObject レスポンス Body は Node 環境では Readable
async function streamBodyToString(body: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("環境変数 S3_BUCKET が設定されていません");
  const region =
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-northeast-1";
  const prefix = (process.env.S3_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  const appId = process.env.KINTONE_APP_ID;

  const opts = parseArgs();
  const fromDate = opts.from ? new Date(opts.from) : undefined;
  const toDate = opts.to ? new Date(opts.to) : undefined;

  const basePrefix = [prefix, "kintone", appId ? `app-${appId}` : undefined]
    .filter(Boolean)
    .join("/");

  console.log(`検索対象バケット: ${bucket}`);
  console.log(`検索プレフィックス: ${basePrefix}/`);
  if (opts.property) console.log(`${opts.propertyField} に "${opts.property}" を含む`);
  if (opts.from) console.log(`${opts.createdField} >= ${opts.from}`);
  if (opts.to) console.log(`${opts.createdField} < ${opts.to}`);
  console.log();

  const client = new S3Client({ region });

  // record.json のキー一覧を収集
  const recordJsonKeys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${basePrefix}/`,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key?.endsWith("/record.json")) recordJsonKeys.push(obj.Key);
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  console.log(`record.json 件数: ${recordJsonKeys.length}`);
  console.log("検索中...（全件スキャンのため時間がかかります）");
  console.log();

  const CONCURRENCY = 20;
  let scanned = 0;
  let matched = 0;

  async function processKey(key: string): Promise<void> {
    const res = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    const body = await streamBodyToString(res.Body);
    const data = JSON.parse(body) as ArchivedRecordJson;

    scanned++;
    if (scanned % 1000 === 0) {
      console.log(`  ...${scanned}/${recordJsonKeys.length} 件スキャン済み`);
    }

    const propertyValue = data.record[opts.propertyField]?.value;
    const createdValue = data.record[opts.createdField]?.value;

    if (
      opts.property &&
      !(typeof propertyValue === "string" && propertyValue.includes(opts.property))
    ) {
      return;
    }

    if (createdValue && typeof createdValue === "string") {
      const created = new Date(createdValue);
      if (fromDate && created < fromDate) return;
      if (toDate && created >= toDate) return;
    }

    matched++;
    console.log(`--- レコード#${data.recordId} ---`);
    console.log(`  ${opts.propertyField}: ${propertyValue}`);
    console.log(`  ${opts.createdField}: ${createdValue}`);
    console.log(`  record.json: s3://${bucket}/${key}`);
    for (const img of data.archivedImages) {
      console.log(`  画像 [${img.fieldCode}] ${img.originalFileName}: ${img.s3Uri}`);
    }
    console.log();
  }

  for (let i = 0; i < recordJsonKeys.length; i += CONCURRENCY) {
    const batch = recordJsonKeys.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processKey));
  }

  console.log(`=== 検索結果: ${matched}件ヒット（${scanned}件中） ===`);
}

main().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
