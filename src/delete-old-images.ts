import type { ApiCounter } from "./api-counter.js";
import { isImageFile } from "./compressor.js";
import { KintoneClient } from "./kintone-client.js";
import type { Config, DeleteResult } from "./types.js";

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

export async function deleteOldImages(
  client: KintoneClient,
  config: Config,
  apiCounter: ApiCounter
): Promise<{ results: DeleteResult[]; stoppedByApiLimit: boolean }> {
  const cutoffDate = getCutoffDate(config.retentionMonths);
  const fieldCode = config.attachmentField;

  console.log(`=== 古い画像の削除 開始 ===`);
  console.log(`保持期間: ${config.retentionMonths}ヶ月`);
  console.log(`基準日: ${cutoffDate} より前のレコードが対象`);
  console.log();

  const query = `作成日時 < "${cutoffDate}" order by $id asc`;
  const records = await client.getAllRecords(query, ["$id", fieldCode]);

  console.log(`対象レコード数: ${records.length}`);

  const results: DeleteResult[] = [];
  let totalDeleted = 0;
  let stoppedByApiLimit = false;

  for (const record of records) {
    // API上限チェック（レコード更新に1回必要）
    if (!apiCounter.hasCapacity(1)) {
      console.log(
        `API呼出上限に達したため削除処理を中断しました (${apiCounter.current}/${config.maxApiCalls})`
      );
      stoppedByApiLimit = true;
      break;
    }

    const recordId = record.$id.value;
    const files = KintoneClient.extractFiles(record, fieldCode);

    if (files.length === 0) continue;

    // 画像と非画像を分離
    const imageFiles = files.filter((f) => isImageFile(f.name));
    const nonImageFiles = files.filter((f) => !isImageFile(f.name));

    // 画像ファイルがなければスキップ
    if (imageFiles.length === 0) continue;

    const result: DeleteResult = {
      recordId,
      deletedFiles: imageFiles.map((f) => f.name),
      keptFiles: nonImageFiles.map((f) => f.name),
    };

    try {
      // 非画像ファイルのみ残す（画像は削除）
      const remainingFileKeys = nonImageFiles.map((f) => ({
        fileKey: f.fileKey,
      }));
      await client.updateRecord(recordId, fieldCode, remainingFileKeys);

      totalDeleted += imageFiles.length;
      console.log(
        `  レコード#${recordId}: ${imageFiles.map((f) => f.name).join(", ")} を削除`
      );
      if (nonImageFiles.length > 0) {
        console.log(
          `    保持: ${nonImageFiles.map((f) => f.name).join(", ")}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = msg;
      console.error(`  レコード#${recordId}: 削除失敗 - ${msg}`);
    }

    results.push(result);
    await sleep(200);
  }

  console.log();
  console.log(`=== 削除結果 ===`);
  console.log(`処理レコード数: ${results.length}`);
  console.log(`削除画像数: ${totalDeleted}`);

  const errorCount = results.filter((r) => r.error).length;
  if (errorCount > 0) {
    console.log(`エラー数: ${errorCount}`);
  }

  return { results, stoppedByApiLimit };
}
