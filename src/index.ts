import { KintoneClient } from "./kintone-client.js";
import { compressToBuffer, isImageFile, toJpegName } from "./compressor.js";
import type { Config, KintoneFileInfo, ProcessResult } from "./types.js";

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
    attachmentField: required("KINTONE_ATTACHMENT_FIELD"),
    maxFileSizeMB: Number(process.env.MAX_FILE_SIZE_MB ?? "1"),
    targetQuality: Number(process.env.TARGET_QUALITY ?? "80"),
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

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new KintoneClient(config);
  const maxSizeBytes = config.maxFileSizeMB * 1024 * 1024;
  const fieldCode = config.attachmentField;

  console.log("=== Kintone画像圧縮バッチ 開始 ===");
  console.log(`対象アプリ: ${config.appId}`);
  console.log(`添付ファイルフィールド: ${fieldCode}`);
  console.log(`圧縮閾値: ${config.maxFileSizeMB}MB`);
  console.log();

  const records = await client.getAllRecords("order by $id asc", [
    "$id",
    fieldCode,
  ]);
  console.log(`取得レコード数: ${records.length}`);

  const results: ProcessResult[] = [];
  let totalCompressed = 0;
  let totalSaved = 0;

  for (const record of records) {
    const recordId = record.$id.value;
    const files = KintoneClient.extractFiles(record, fieldCode);

    if (files.length === 0) continue;

    // Check if any file needs compression
    const needsCompression = files.some(
      (f) => isImageFile(f.name) && Number(f.size) > maxSizeBytes
    );
    if (!needsCompression) continue;

    const result: ProcessResult = {
      recordId,
      files: [],
      skipped: 0,
      errors: [],
    };

    const updatedFileKeys: Array<{ fileKey: string }> = [];
    let recordModified = false;

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
          `  レコード#${recordId}: ${file.name} (${formatSize(fileSize)}) を圧縮中...`
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
          recordModified = true;
          totalCompressed++;
          totalSaved += compressed.result.originalSize - compressed.result.compressedSize;

          console.log(
            `    -> ${compressed.result.newName} (${formatSize(compressed.result.compressedSize)}) に圧縮完了`
          );
        } else {
          updatedFileKeys.push({ fileKey: file.fileKey });
          result.skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${file.name}: ${msg}`);
        updatedFileKeys.push({ fileKey: file.fileKey });
        console.error(`    エラー: ${file.name} - ${msg}`);
      }
    }

    if (recordModified) {
      try {
        await client.updateRecord(recordId, fieldCode, updatedFileKeys);
        console.log(`  レコード#${recordId}: 更新完了`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`レコード更新失敗: ${msg}`);
        console.error(`  レコード#${recordId}: 更新失敗 - ${msg}`);
      }
    }

    results.push(result);

    // Rate limiting: wait between records to avoid hitting API limits
    await sleep(200);
  }

  // Summary
  console.log();
  console.log("=== 処理結果 ===");
  console.log(`処理レコード数: ${results.length}`);
  console.log(`圧縮ファイル数: ${totalCompressed}`);
  console.log(`削減サイズ合計: ${formatSize(totalSaved)}`);

  const errorCount = results.reduce((sum, r) => sum + r.errors.length, 0);
  if (errorCount > 0) {
    console.log(`エラー数: ${errorCount}`);
    for (const r of results) {
      for (const e of r.errors) {
        console.error(`  レコード#${r.recordId}: ${e}`);
      }
    }
    process.exit(1);
  }

  console.log("=== 完了 ===");
}

main().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
