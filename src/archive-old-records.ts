import type { ApiCounter } from "./api-counter.js";
import { isImageFile } from "./compressor.js";
import { KintoneClient } from "./kintone-client.js";
import {
  S3ArchiveClient,
  type ArchivedImageInfo,
} from "./s3-client.js";
import type { ArchiveRecordResult, Config, KintoneFileInfo } from "./types.js";

// 実行月の retentionMonths ヶ月前の「月初日」を基準にする。
// 例: 8月実行・retentionMonths=3 なら 5/1 が基準となり、5・6・7月分は丸ごと残る。
function getCutoffDate(retentionMonths: number): string {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - retentionMonths, 1);
  const yyyy = cutoff.getFullYear();
  const mm = String(cutoff.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}-01`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function archiveOldRecords(
  client: KintoneClient,
  s3Client: S3ArchiveClient,
  config: Config,
  apiCounter: ApiCounter
): Promise<{ results: ArchiveRecordResult[]; stoppedByApiLimit: boolean }> {
  const cutoffDate = getCutoffDate(config.retentionMonths);
  const fieldCodes = config.attachmentFields;
  const query = config.archiveQuery || `作成日時 < "${cutoffDate}"`;

  console.log(`=== 古いレコードのS3アーカイブ 開始 ===`);
  console.log(`保持期間: ${config.retentionMonths}ヶ月`);
  if (config.archiveQuery) {
    console.log(`対象条件: ${config.archiveQuery}`);
  } else {
    console.log(`基準日: ${cutoffDate} より前のレコードが対象`);
  }
  console.log(`画像対象フィールド: ${fieldCodes.join(", ")}`);
  if (config.batchSize > 0) {
    console.log(`バッチサイズ: ${config.batchSize}件`);
  }
  console.log(`S3バケット: ${config.s3Bucket}`);
  if (config.s3Prefix) {
    console.log(`S3プレフィックス: ${config.s3Prefix}`);
  }
  console.log();

  const records = await client.getAllRecordsWithAllFields(query);

  console.log(`対象レコード数: ${records.length}`);

  const results: ArchiveRecordResult[] = [];
  let totalArchivedRecords = 0;
  let totalArchivedImages = 0;
  let processedCount = 0;
  let stoppedByApiLimit = false;

  for (const record of records) {
    const recordId = record.$id.value;

    if (config.batchSize > 0 && processedCount >= config.batchSize) {
      console.log(`バッチサイズ上限 (${config.batchSize}件) に達しました`);
      break;
    }

    processedCount++;

    const imageFilesByField = collectImageFilesByField(record, fieldCodes);
    const imageCount = imageFilesByField.reduce(
      (sum, item) => sum + item.files.length,
      0
    );

    // Kintone APIは画像ごとのdownloadとレコード削除で消費する。
    if (!apiCounter.hasCapacity(imageCount + 1)) {
      console.log(
        `API呼出上限に達したためレコードアーカイブ処理を中断しました (${apiCounter.current}/${config.maxApiCalls})`
      );
      stoppedByApiLimit = true;
      break;
    }

    const result: ArchiveRecordResult = {
      recordId,
      archivedFiles: [],
      s3Keys: [],
      deleted: false,
    };

    try {
      const archivedAt = new Date().toISOString();
      const archivedImages: ArchivedImageInfo[] = [];

      for (const { fieldCode, files } of imageFilesByField) {
        for (const file of files) {
          console.log(
            `  レコード#${recordId} [${fieldCode}]: ${file.name} をS3へ退避中...`
          );
          const data = await client.downloadFile(file.fileKey);
          const s3Key = await s3Client.uploadImage({
            recordId,
            fieldCode,
            file,
            data,
          });
          result.archivedFiles.push(`${fieldCode}/${file.name}`);
          result.s3Keys.push(s3Key);
          archivedImages.push({
            fieldCode,
            originalFileName: file.name,
            originalFileKey: file.fileKey,
            contentType: file.contentType,
            size: file.size,
            bucket: s3Client.getBucketName(),
            key: s3Key,
            s3Uri: s3Client.createS3Uri(s3Key),
          });
          console.log(`    -> ${s3Client.createS3Uri(s3Key)}`);
        }
      }

      console.log(`  レコード#${recordId}: レコードJSONをS3へ保存中...`);
      const recordJsonKey = await s3Client.uploadRecordJson({
        recordId,
        record,
        archivedAt,
        archivedImages,
      });
      result.recordJsonKey = recordJsonKey;
      result.s3Keys.push(recordJsonKey);
      console.log(`    -> ${s3Client.createS3Uri(recordJsonKey)}`);

      await client.deleteRecord(recordId);
      result.deleted = true;
      totalArchivedRecords++;
      totalArchivedImages += imageCount;
      console.log(`  レコード#${recordId}: S3アーカイブ後にKintoneから削除`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = msg;
      console.error(
        `  レコード#${recordId}: アーカイブまたは削除失敗 - ${msg}`
      );
    }

    results.push(result);

    if (result.deleted) {
      await sleep(200);
    }
  }

  console.log();
  console.log(`=== レコードアーカイブ結果 ===`);
  console.log(`処理レコード数: ${results.length}`);
  console.log(`アーカイブ後削除レコード数: ${totalArchivedRecords}`);
  console.log(`退避画像数: ${totalArchivedImages}`);

  const errorCount = results.filter((r) => r.error).length;
  if (errorCount > 0) {
    console.log(`エラー数: ${errorCount}`);
  }

  return { results, stoppedByApiLimit };
}

function collectImageFilesByField(
  record: Parameters<typeof KintoneClient.extractFiles>[0],
  fieldCodes: string[]
): Array<{ fieldCode: string; files: KintoneFileInfo[] }> {
  return fieldCodes
    .map((fieldCode) => ({
      fieldCode,
      files: KintoneClient.extractFiles(record, fieldCode).filter((f) =>
        isImageFile(f.name)
      ),
    }))
    .filter((item) => item.files.length > 0);
}
