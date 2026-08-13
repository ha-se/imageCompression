# Kintone Image Compressor

Kintone の添付ファイルフィールドにある画像を自動で圧縮するバッチツールです。

指定した添付フィールドを走査し、しきい値より大きい画像を `sharp` で JPEG に変換・圧縮して、Kintone レコードの添付ファイルを差し替えます。必要に応じて、一定期間より古いレコードの画像添付を削除することもできます。

## 主な機能

- Kintone 添付ファイルフィールドの画像を自動圧縮
- 複数の添付フィールドに対応
- JPEG / PNG / HEIC / HEIF / WebP / AVIF / TIFF などを画像として判定
- 画像を JPEG に変換し、品質調整とリサイズでファイルサイズを削減
- `$id` ベースのページングで 10,000 件超のレコード取得に対応
- `LAST_PROCESSED_UPDATED_AT`（レコードの更新日時）による差分実行。既にスキャン済みのレコードに後から写真が追加・差し替えされた場合も取りこぼさない
- API 呼び出し上限とバッチサイズによる実行制御
- 古いレコードの JSON と画像を S3 にアーカイブしてから Kintone レコードを削除
- 古いレコードの画像添付を S3 に退避してから Kintone から削除
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
| `ENABLE_ARCHIVE_OLD_RECORDS` | `false` | `true` の場合、古いレコードの JSON と画像を S3 に保存してから Kintone レコードを削除する |
| `ENABLE_ARCHIVE_OLD_IMAGES` | `false` | `true` の場合、古い画像を S3 に退避してから Kintone から削除する |
| `ENABLE_DELETE_OLD_IMAGES` | `false` | `true` の場合、圧縮前に古い画像を削除する |
| `S3_BUCKET` | 空 | S3 退避先バケット名。S3 アーカイブ機能を使う場合は必須 |
| `S3_PREFIX` | 空 | S3 オブジェクトキーの先頭に付けるプレフィックス |
| `AWS_REGION` | `ap-northeast-1` | S3 バケットのリージョン |
| `MAX_API_CALLS` | `9000` | 1 回の実行で許可する API 呼び出し数 |
| `BATCH_SIZE` | `100` | 1 回の実行で走査するレコード数。`0` で無制限 |
| `LAST_PROCESSED_UPDATED_AT` | 空 | 指定時は `更新日時` がこの値より後のレコードのみ処理する |
| `ARCHIVE_QUERY` | 空 | アーカイブ/削除対象を上書きする Kintone クエリ。空の場合は `RETENTION_MONTHS` で判定 |

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

`LAST_PROCESSED_UPDATED_AT` を指定すると、以下の条件でレコードを取得します。

```text
更新日時 > LAST_PROCESSED_UPDATED_AT
```

レコードは `更新日時` の昇順で取得されます。`$id` ベースの一方向カーソルとは異なり、
一度スキャンした後にレコードが編集されて写真が追加・差し替えされた場合も、`更新日時` が
更新されるため次回実行時に再検出されます。

実行後、最後に走査したレコードの更新日時（安全マージンとして 10 秒過去に戻した値）がログに
出力されます。

```text
LAST_PROCESSED_UPDATED_AT=2026-08-13T05:00:00Z
```

この安全マージンにより、同一の `更新日時` を持つレコードが取得ページの境界で取りこぼされることを
防ぎます。境界付近のレコードは次回実行時に再スキャンされることがありますが、圧縮済みファイルは
閾値以下になっているため即座にスキップされ、追加コストはわずかです。

GitHub Actions ではこの値を読み取り、repository variable の `LAST_PROCESSED_UPDATED_AT` を更新します。

## 古いレコードの S3 アーカイブ

`ENABLE_ARCHIVE_OLD_RECORDS=true` の場合、圧縮処理の前に古い Kintone レコードを S3 にアーカイブし、アーカイブに成功したあと Kintone からレコード自体を削除します。

削除対象は、`作成日時` が基準日（実行月から `RETENTION_MONTHS` ヶ月前の月の1日）より前のレコードです。例えば 8 月に `RETENTION_MONTHS=3` で実行すると、基準日は 5/1 になり、5・6・7 月分は丸ごと Kintone に残ります。S3 には、レコード JSON 全体と、対象添付フィールド内の画像ファイルを別々に保存します。

テストなどで対象期間を明示したい場合は、`ARCHIVE_QUERY` で Kintone クエリを指定できます。たとえば 2025年分だけを対象にする場合は、以下を指定します。

```text
作成日時 >= "2025-01-01" and 作成日時 < "2026-01-01"
```

保存されるレコード JSON:

```text
{S3_PREFIX}/kintone/app-{appId}/record-{recordId}/record.json
```

保存される画像:

```text
{S3_PREFIX}/kintone/app-{appId}/record-{recordId}/{fieldCode}/{fileKey}-{fileName}
```

`record.json` には Kintone レコード全体に加えて、S3 に保存した画像の `bucket`、`key`、`s3Uri`、元ファイル名、元 `fileKey`、`contentType`、`size` が含まれます。

処理順序は、画像保存、画像の S3 URI を含むレコード JSON 保存、Kintone レコード削除です。途中で失敗した場合、Kintone レコードは削除しません。

## 古い画像の S3 退避

`ENABLE_ARCHIVE_OLD_IMAGES=true` の場合、圧縮処理の前に古いレコードの画像添付を S3 に退避し、退避に成功したあと Kintone の添付ファイルフィールドから削除します。

削除対象は、`作成日時` が基準日（実行月から `RETENTION_MONTHS` ヶ月前の月の1日）より前のレコードです。対象フィールド内の画像ファイルだけを S3 に保存して Kintone から削除し、非画像ファイルは Kintone に残します。

S3 のオブジェクトキーは、以下の形式で作成されます。

```text
{S3_PREFIX}/kintone/app-{appId}/record-{recordId}/{fieldCode}/{fileKey}-{fileName}
```

`S3_PREFIX` が空の場合、先頭の `{S3_PREFIX}/` は付きません。S3 へのアップロードには AWS SDK の標準認証チェーンを使います。GitHub Actions では `AWS_ACCESS_KEY_ID` と `AWS_SECRET_ACCESS_KEY` を Secrets に設定してください。

## 古い画像の削除のみ

`ENABLE_DELETE_OLD_IMAGES=true` の場合、圧縮処理の前に古いレコードの画像添付を削除します。

削除対象は、`作成日時` が基準日（実行月から `RETENTION_MONTHS` ヶ月前の月の1日）より前のレコードです。対象フィールド内の画像ファイルだけを削除し、非画像ファイルは残します。

`ENABLE_ARCHIVE_OLD_RECORDS=true` の場合はレコードアーカイブが最優先されます。`ENABLE_ARCHIVE_OLD_IMAGES=true` の場合は画像退避が次に優先され、`ENABLE_DELETE_OLD_IMAGES` は実行されません。

## GitHub Actions

[`.github/workflows/compress-images.yml`](.github/workflows/compress-images.yml) で、毎時0分（UTC基準）に実行されます。差分実行と組み合わせることで、レコードの新規作成・更新（写真の追加や差し替えを含む）にバッチ処理が追いつくようにしています。Kintone の API 呼び出し上限や GitHub Actions の実行時間消費が気になる場合は、cron 式（`0 * * * *`）を 2〜3 時間おきなどに調整してください。

必要な GitHub Secrets:

| Secret | 説明 |
| --- | --- |
| `KINTONE_BASE_URL` | Kintone のベース URL |
| `KINTONE_API_TOKEN` | Kintone API トークン |
| `KINTONE_APP_ID` | 対象アプリ ID |
| `KINTONE_ATTACHMENT_FIELD` | 添付ファイルフィールドコード。対象アプリに複数の写真・添付フィールドがある場合は、圧縮対象にしたい全フィールドのコードをカンマ区切りで指定する（一部の写真だけ圧縮されない場合は、まずここに漏れがないか確認する） |
| `PAT_TOKEN` | `LAST_PROCESSED_UPDATED_AT` の repository variable 更新に使う GitHub token |
| `S3_BUCKET` | S3 アーカイブ先バケット名 |
| `AWS_ACCESS_KEY_ID` | S3 書き込み権限を持つ AWS アクセスキー |
| `AWS_SECRET_ACCESS_KEY` | S3 書き込み権限を持つ AWS シークレットアクセスキー |

主な GitHub Variables:

| Variable | 説明 |
| --- | --- |
| `MAX_FILE_SIZE_MB` | 圧縮対象サイズ |
| `TARGET_QUALITY` | JPEG 品質 |
| `RETENTION_MONTHS` | 古い画像の保持月数 |
| `ENABLE_ARCHIVE_OLD_RECORDS` | 古いレコードの S3 アーカイブと Kintone レコード削除の有効化 |
| `ENABLE_ARCHIVE_OLD_IMAGES` | 古い画像の S3 退避の有効化 |
| `ENABLE_DELETE_OLD_IMAGES` | 古い画像削除の有効化 |
| `S3_PREFIX` | S3 オブジェクトキーのプレフィックス |
| `AWS_REGION` | S3 バケットのリージョン |
| `MAX_API_CALLS` | API 呼び出し上限 |
| `BATCH_SIZE` | バッチサイズ |
| `LAST_PROCESSED_UPDATED_AT` | 差分実行の開始位置（更新日時） |

手動実行時は、以下を指定できます。

- `batch_size`: 処理レコード上限
- `enable_record_archive`: 古いレコード全体を S3 へアーカイブして Kintone から削除
- `enable_archive`: 古い画像を S3 へ退避して Kintone から削除
- `enable_delete`: 古い画像削除の有効化
- `full_scan`: 差分モードを無効化して全件走査
- `timeout`: タイムアウト分数
- `archive_query`: アーカイブ/削除対象の Kintone クエリ。空なら保持期間で判定

## 注意事項

- 圧縮後のファイル名は拡張子が `.jpg` になります。
- Kintone の添付ファイル差し替えはフィールド単位で行われます。
- 圧縮対象外のファイルは元の `fileKey` を維持します。
- レコードアーカイブ機能は、レコード JSON と画像の S3 保存に成功したあとで Kintone レコードを削除します。
- S3 退避機能は、対象画像のアップロードに成功したあとで Kintone から画像を外します。
- 画像削除機能は、対象フィールド内の画像添付をレコードから外します。実行前に対象条件を確認してください。
- API 呼び出し数が上限に近づくと処理を中断します。残りは次回実行で処理されます。
