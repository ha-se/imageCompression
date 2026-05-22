import type { ApiCounter } from "./api-counter.js";
import { isImageFile } from "./compressor.js";
import { KintoneClient } from "./kintone-client.js";
import { S3ArchiveClient } from "./s3-client.js";
import type { ArchiveResult, Config } from "./types.js";

function getCutoffDate(retentionMonths: number): string {
  const now = new Date();
  now.setMonth(now.getMonth() - retentionMonths);
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function archiveOldImages(
  client: KintoneClient,
  s3Client: S3ArchiveClient,
  config: Config,
  apiCounter: ApiCounter
): Promise<{ results: ArchiveResult[]; stoppedByApiLimit: boolean }> {
  const cutoffDate = getCutoffDate(config.retentionMonths);
  const fieldCodes = config.attachmentFields;
  const query = config.archiveQuery || `作成日時 < "${cutoffDate}"`;

  console.log(`=== 古い画像のS3退避 開始 ===`);
  console.log(`保持期間: ${config.retentionMonths}ヶ月`);
  if (config.archiveQuery) {
    console.log(`対象条件: ${config.archiveQuery}`);
  } else {
    console.log(`基準日: ${cutoffDate} より前のレコードが対象`);
  }
  console.log(`対象フィールド: ${fieldCodes.join(", ")}`);
  console.log(`S3バケット: ${config.s3Bucket}`);
  if (config.s3Prefix) {
    console.log(`S3プレフィックス: ${config.s3Prefix}`);
  }
  console.log();

  const records = await client.getAllRecords(query, ["$id", ...fieldCodes]);

  console.log(`対象レコード数: ${records.length}`);

  const results: ArchiveResult[] = [];
  let totalArchived = 0;
  let stoppedByApiLimit = false;

  for (const record of records) {
    const recordId = record.$id.value;
    let recordHasArchived = false;

    for (const fieldCode of fieldCodes) {
      const files = KintoneClient.extractFiles(record, fieldCode);
      if (files.length === 0) continue;

      const imageFiles = files.filter((f) => isImageFile(f.name));
      const nonImageFiles = files.filter((f) => !isImageFile(f.name));
      if (imageFiles.length === 0) continue;

      // Kintone APIは画像ごとのdownloadとフィールド更新で消費する。
      if (!apiCounter.hasCapacity(imageFiles.length + 1)) {
        console.log(
          `API呼出上限に達したためS3退避処理を中断しました (${apiCounter.current}/${config.maxApiCalls})`
        );
        stoppedByApiLimit = true;
        break;
      }

      const result: ArchiveResult = {
        recordId,
        archivedFiles: [],
        keptFiles: nonImageFiles.map((f) => f.name),
        s3Keys: [],
      };

      try {
        for (const imageFile of imageFiles) {
          console.log(
            `  レコード#${recordId} [${fieldCode}]: ${imageFile.name} をS3へ退避中...`
          );
          const data = await client.downloadFile(imageFile.fileKey);
          const s3Key = await s3Client.uploadImage({
            recordId,
            fieldCode,
            file: imageFile,
            data,
          });
          result.archivedFiles.push(imageFile.name);
          result.s3Keys.push(s3Key);
          console.log(`    -> s3://${config.s3Bucket}/${s3Key}`);
        }

        const remainingFileKeys = nonImageFiles.map((f) => ({
          fileKey: f.fileKey,
        }));
        await client.updateRecord(recordId, fieldCode, remainingFileKeys);

        totalArchived += imageFiles.length;
        recordHasArchived = true;
        console.log(
          `  レコード#${recordId} [${fieldCode}]: S3退避後にKintoneから画像を削除`
        );
        if (nonImageFiles.length > 0) {
          console.log(
            `    保持: ${nonImageFiles.map((f) => f.name).join(", ")}`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.error = msg;
        console.error(
          `  レコード#${recordId} [${fieldCode}]: S3退避または削除失敗 - ${msg}`
        );
      }

      results.push(result);
    }

    if (stoppedByApiLimit) break;

    if (recordHasArchived) {
      await sleep(200);
    }
  }

  console.log();
  console.log(`=== S3退避結果 ===`);
  console.log(`処理レコード数: ${results.length}`);
  console.log(`退避画像数: ${totalArchived}`);

  const errorCount = results.filter((r) => r.error).length;
  if (errorCount > 0) {
    console.log(`エラー数: ${errorCount}`);
  }

  return { results, stoppedByApiLimit };
}
