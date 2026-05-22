# Kintone Image Compressor

Kintone の添付ファイルフィールドにある画像を自動で圧縮するバッチツールです。

指定した添付フィールドを走査し、しきい値より大きい画像を `sharp` で JPEG に変換・圧縮して、Kintone レコードの添付ファイルを差し替えます。必要に応じて、一定期間より古いレコードの画像添付を削除することもできます。

## 主な機能

- Kintone 添付ファイルフィールドの画像を自動圧縮
- 複数の添付フィールドに対応
- JPEG / PNG / HEIC / HEIF / WebP / AVIF / TIFF などを画像として判定
- 画像を JPEG に変換し、品質調整とリサイズでファイルサイズを削減
- `$id` ベースのページングで 10,000 件超のレコード取得に対応
- `LAST_PROCESSED_ID` による差分実行
- API 呼び出し上限とバッチサイズによる実行制御
- 古いレコードの画像添付削除
- GitHub Actions による定期実行

## 必要環境

- Node.js 20 以上
- npm
- Kintone API トークン

API トークンには、対象アプリのレコード閲覧、レコード編集、ファイル操作に必要な権限を付与してください。

## セットアップ

```bash
npm ci
```

型チェック:

```bash
npm run typecheck
```

ローカル実行:

```bash
npm start
```

## 環境変数

必須:

| 変数名 | 説明 |
| --- | --- |
| `KINTONE_BASE_URL` | Kintone のベース URL。例: `https://example.cybozu.com` |
| `KINTONE_API_TOKEN` | Kintone API トークン |
| `KINTONE_APP_ID` | 対象アプリ ID |
| `KINTONE_ATTACHMENT_FIELD` | 対象の添付ファイルフィールドコード。複数指定はカンマ区切り |

任意:

| 変数名 | デフォルト | 説明 |
| --- | ---: | --- |
| `MAX_FILE_SIZE_MB` | `1` | このサイズを超える画像を圧縮対象にする |
| `TARGET_QUALITY` | `80` | 圧縮開始時の JPEG 品質 |
| `RETENTION_MONTHS` | `3` | 古い画像削除時に保持する月数 |
| `ENABLE_DELETE_OLD_IMAGES` | `false` | `true` の場合、圧縮前に古い画像を削除する |
| `MAX_API_CALLS` | `9000` | 1 回の実行で許可する API 呼び出し数 |
| `BATCH_SIZE` | `500` | 1 回の実行で走査するレコード数。`0` で無制限 |
| `LAST_PROCESSED_ID` | 空 | 指定時は `$id` がこの値より大きいレコードのみ処理する |

`.env` ファイルは `.gitignore` に含まれていますが、このツール自体は `.env` を自動読み込みしません。ローカルで使う場合は、シェルや実行環境から環境変数を渡してください。

例:

```bash
KINTONE_BASE_URL="https://example.cybozu.com" \
KINTONE_API_TOKEN="your-api-token" \
KINTONE_APP_ID="123" \
KINTONE_ATTACHMENT_FIELD="添付ファイル" \
npm start
```

## 圧縮の流れ

1. 対象アプリから `$id` と指定した添付ファイルフィールドを取得します。
2. 添付ファイルのうち、画像かつ `MAX_FILE_SIZE_MB` を超えるものを探します。
3. 対象画像をダウンロードします。
4. `sharp` で EXIF orientation を適用したうえで JPEG に変換します。
5. 品質を段階的に下げ、必要に応じて長辺をリサイズします。
6. 圧縮後の画像を Kintone にアップロードします。
7. レコードの添付ファイルフィールドを、新しい `fileKey` に更新します。

画像以外の添付ファイルや、すでにしきい値以下の画像はそのまま残ります。

## 差分実行

`LAST_PROCESSED_ID` を指定すると、以下の条件でレコードを取得します。

```text
$id > LAST_PROCESSED_ID
```

実行後、最後に走査したレコード ID がログに出力されます。

```text
LAST_PROCESSED_ID=12345
```

GitHub Actions ではこの値を読み取り、repository variable の `LAST_PROCESSED_ID` を更新します。

## 古い画像の削除

`ENABLE_DELETE_OLD_IMAGES=true` の場合、圧縮処理の前に古いレコードの画像添付を削除します。

削除対象は、`作成日時` が `RETENTION_MONTHS` ヶ月より前のレコードです。対象フィールド内の画像ファイルだけを削除し、非画像ファイルは残します。

## GitHub Actions

[`.github/workflows/compress-images.yml`](.github/workflows/compress-images.yml) で、毎日 JST 6:00 に実行されます。

必要な GitHub Secrets:

| Secret | 説明 |
| --- | --- |
| `KINTONE_BASE_URL` | Kintone のベース URL |
| `KINTONE_API_TOKEN` | Kintone API トークン |
| `KINTONE_APP_ID` | 対象アプリ ID |
| `KINTONE_ATTACHMENT_FIELD` | 添付ファイルフィールドコード |
| `PAT_TOKEN` | `LAST_PROCESSED_ID` の repository variable 更新に使う GitHub token |

主な GitHub Variables:

| Variable | 説明 |
| --- | --- |
| `MAX_FILE_SIZE_MB` | 圧縮対象サイズ |
| `TARGET_QUALITY` | JPEG 品質 |
| `RETENTION_MONTHS` | 古い画像の保持月数 |
| `ENABLE_DELETE_OLD_IMAGES` | 古い画像削除の有効化 |
| `MAX_API_CALLS` | API 呼び出し上限 |
| `BATCH_SIZE` | バッチサイズ |
| `LAST_PROCESSED_ID` | 差分実行の開始位置 |

手動実行時は、以下を指定できます。

- `batch_size`: 処理レコード上限
- `enable_delete`: 古い画像削除の有効化
- `full_scan`: 差分モードを無効化して全件走査
- `timeout`: タイムアウト分数

## 注意事項

- 圧縮後のファイル名は拡張子が `.jpg` になります。
- Kintone の添付ファイル差し替えはフィールド単位で行われます。
- 圧縮対象外のファイルは元の `fileKey` を維持します。
- 画像削除機能は、対象フィールド内の画像添付をレコードから外します。実行前に対象条件を確認してください。
- API 呼び出し数が上限に近づくと処理を中断します。残りは次回実行で処理されます。

