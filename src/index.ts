import { ApiCounter } from "./api-counter.js";
import { compressToBuffer, isImageFile } from "./compressor.js";
import { deleteOldImages } from "./delete-old-images.js";
import { KintoneClient } from "./kintone-client.js";
import type { Config, ProcessResult } from "./types.js";

function loadConfig(): Config {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
    return val;
  };

  return {
    baseUrl: required("KINTONE_BASE_URL"),
    apiToken: required("KINTONE_API_TOKEN"),
    appId: required("KINTONE_APP_ID"),
    attachmentFields: required("KINTONE_ATTACHMENT_FIELD")
      .split(",")
      .map((s) => s.trim()),
    maxFileSizeMB: Number(process.env.MAX_FILE_SIZE_MB ?? "1"),
    targetQuality: Number(process.env.TARGET_QUALITY ?? "80"),
    retentionMonths: Number(process.env.RETENTION_MONTHS ?? "3"),
    enableDeleteOldImages: process.env.ENABLE_DELETE_OLD_IMAGES === "true",
    maxApiCalls: Number(process.env.MAX_API_CALLS ?? "9000"),
    batchSize: Number(process.env.BATCH_SIZE ?? "0"),
    lastProcessedId: process.env.LAST_PROCESSED_ID ?? "",
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCompression(
  client: KintoneClient,
  config: Config,
  apiCounter: ApiCounter
): Promise<{ hasErrors: boolean }> {
  const maxSizeBytes = config.maxFileSizeMB * 1024 * 1024;
  const fieldCodes = config.attachmentFields;

  console.log(`対象フィールド: ${fieldCodes.join(", ")}`);
  console.log(`圧縮閾値: ${config.maxFileSizeMB}MB`);
  if (config.batchSize > 0) {
    console.log(`バッチサイズ: ${config.batchSize}件`);
  }

  // 差分取得: LAST_PROCESSED_ID が設定されている場合、それより大きいIDのレコードのみ取得
  const isIncrementalMode = config.lastProcessedId !== "";
  if (isIncrementalMode) {
    console.log(`差分モード: $id > ${config.lastProcessedId} のレコードのみ取得`);
  } else {
    console.log("フルスキャンモード: 全レコードを取得");
  }
  console.log();

  // 全フィールドをまとめて1回で取得
  const query = isIncrementalMode
    ? `$id > "${config.lastProcessedId}"`
    : "";
  const fields = ["$id", ...fieldCodes];
  const records = await client.getAllRecords(query, fields);
  console.log(`取得レコード数: ${records.length}`);

  const results: ProcessResult[] = [];
  let totalCompressed = 0;
  let totalSaved = 0;
  let processedCount = 0;
  let stoppedByApiLimit = false;
  let maxId = "0";

  for (const record of records) {
    // バッチサイズ制限チェック
    if (config.batchSize > 0 && processedCount >= config.batchSize) {
      console.log(`バッチサイズ上限 (${config.batchSize}件) に達しました`);
      break;
    }

    // API上限チェック（最低3回必要: download + upload + update）
    if (!apiCounter.hasCapacity(3)) {
      console.log(
        `API呼出上限に達したため圧縮処理を中断しました (${apiCounter.current}/${config.maxApiCalls})`
      );
      stoppedByApiLimit = true;
      break;
    }

    const recordId = record.$id.value;

    // 最大IDを追跡
    if (Number(recordId) > Number(maxId)) {
      maxId = recordId;
    }

    // 全フィールドの添付ファイルを確認
    let recordNeedsCompression = false;
    for (const fieldCode of fieldCodes) {
      const files = KintoneClient.extractFiles(record, fieldCode);
      if (
        files.some((f) => isImageFile(f.name) && Number(f.size) > maxSizeBytes)
      ) {
        recordNeedsCompression = true;
        break;
      }
    }
    if (!recordNeedsCompression) continue;

    const result: ProcessResult = {
      recordId,
      files: [],
      skipped: 0,
      errors: [],
    };

    // フィールドごとに圧縮処理
    for (const fieldCode of fieldCodes) {
      const files = KintoneClient.extractFiles(record, fieldCode);
      if (files.length === 0) continue;

      const needsCompression = files.some(
        (f) => isImageFile(f.name) && Number(f.size) > maxSizeBytes
      );
      if (!needsCompression) continue;

      const updatedFileKeys: Array<{ fileKey: string }> = [];
      let fieldModified = false;

      for (const file of files) {
        const fileSize = Number(file.size);

        // Skip non-image or already small files
        if (!isImageFile(file.name) || fileSize <= maxSizeBytes) {
          updatedFileKeys.push({ fileKey: file.fileKey });
          result.skipped++;
          continue;
        }

        try {
          console.log(
            `  レコード#${recordId} [${fieldCode}]: ${file.name} (${formatSize(fileSize)}) を圧縮中...`
          );

          const buffer = await client.downloadFile(file.fileKey);
          const compressed = await compressToBuffer(
            buffer,
            file.name,
            maxSizeBytes,
            config.targetQuality
          );

          if (compressed) {
            const uploaded = await client.uploadFile(
              compressed.result.newName,
              compressed.data
            );
            updatedFileKeys.push({ fileKey: uploaded.fileKey });
            result.files.push(compressed.result);
            fieldModified = true;
            totalCompressed++;
            totalSaved +=
              compressed.result.originalSize - compressed.result.compressedSize;

            console.log(
              `    -> ${compressed.result.newName} (${formatSize(compressed.result.compressedSize)}) に圧縮完了`
            );
          } else {
            updatedFileKeys.push({ fileKey: file.fileKey });
            result.skipped++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${fieldCode}/${file.name}: ${msg}`);
          updatedFileKeys.push({ fileKey: file.fileKey });
          console.error(`    エラー: ${file.name} - ${msg}`);
        }
      }

      if (fieldModified) {
        try {
          await client.updateRecord(recordId, fieldCode, updatedFileKeys);
          console.log(`  レコード#${recordId} [${fieldCode}]: 更新完了`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${fieldCode} レコード更新失敗: ${msg}`);
          console.error(
            `  レコード#${recordId} [${fieldCode}]: 更新失敗 - ${msg}`
          );
        }
      }
    }

    results.push(result);
    processedCount++;

    // Rate limiting: wait between records to avoid hitting API limits
    await sleep(200);
  }

  // Summary
  console.log();
  console.log("=== 圧縮結果 ===");
  console.log(`処理レコード数: ${results.length}`);
  console.log(`圧縮ファイル数: ${totalCompressed}`);
  console.log(`削減サイズ合計: ${formatSize(totalSaved)}`);
  console.log(`API呼出数: ${apiCounter.current}`);

  if (stoppedByApiLimit) {
    console.log("※ API上限により中断 — 残りは次回実行時に処理されます");
  }

  // 最大IDを出力（GitHub Actionsで変数更新に使用）
  if (records.length > 0) {
    console.log(`LAST_PROCESSED_ID=${maxId}`);
  }

  const errorCount = results.reduce((sum, r) => sum + r.errors.length, 0);
  if (errorCount > 0) {
    console.log(`エラー数: ${errorCount}`);
    for (const r of results) {
      for (const e of r.errors) {
        console.error(`  レコード#${r.recordId}: ${e}`);
      }
    }
  }

  return { hasErrors: errorCount > 0 };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const apiCounter = new ApiCounter(config.maxApiCalls);
  const client = new KintoneClient(config, apiCounter);
  let hasErrors = false;

  // Phase 1: 古い画像の削除（有効時のみ）
  if (config.enableDeleteOldImages) {
    const deleteResult = await deleteOldImages(client, config, apiCounter);
    const deleteErrors = deleteResult.results.filter((r) => r.error).length;
    if (deleteErrors > 0) hasErrors = true;

    if (deleteResult.stoppedByApiLimit) {
      console.log();
      console.log("API上限により圧縮処理はスキップします");
      console.log("=== 完了 ===");
      process.exit(hasErrors ? 1 : 0);
    }
    console.log();
  }

  // Phase 2: 画像圧縮（全フィールドをレコード単位で処理）
  console.log("=== Kintone画像圧縮バッチ 開始 ===");
  console.log(`対象アプリ: ${config.appId}`);
  console.log();

  const compressResult = await runCompression(client, config, apiCounter);
  if (compressResult.hasErrors) hasErrors = true;

  console.log("=== 完了 ===");

  if (hasErrors) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
