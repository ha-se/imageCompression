// Kintoneアプリのフィールド一覧（フィールドコードとラベルの対応）を確認するための診断スクリプト。
// レコードAPIはフィールドコードのみを返しラベルを返さないため、
// フィールドコードとKintone画面上の表示名（ラベル）が一致しない場合に、対応関係を確認する用途で使う。

interface KintoneFormField {
  type: string;
  code: string;
  label: string;
}

interface KintoneFormFieldsResponse {
  properties: Record<string, KintoneFormField>;
}

async function main(): Promise<void> {
  const baseUrl = process.env.KINTONE_BASE_URL;
  const apiToken = process.env.KINTONE_API_TOKEN;
  const appId = process.env.KINTONE_APP_ID;
  if (!baseUrl) throw new Error("環境変数 KINTONE_BASE_URL が設定されていません");
  if (!apiToken) throw new Error("環境変数 KINTONE_API_TOKEN が設定されていません");
  if (!appId) throw new Error("環境変数 KINTONE_APP_ID が設定されていません");

  const params = new URLSearchParams({ app: appId });
  const res = await fetch(
    `${baseUrl.replace(/\/$/, "")}/k/v1/app/form/fields.json?${params.toString()}`,
    { headers: { "X-Cybozu-API-Token": apiToken } }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get form fields: ${res.status} ${body}`);
  }

  const data = (await res.json()) as KintoneFormFieldsResponse;

  console.log("=== フィールド一覧 ===");
  console.log(`${"フィールドコード".padEnd(30)} ${"タイプ".padEnd(20)} ラベル`);
  for (const field of Object.values(data.properties)) {
    console.log(`${field.code.padEnd(30)} ${field.type.padEnd(20)} ${field.label}`);
  }

  console.log();
  console.log("=== FILE型フィールドのみ ===");
  for (const field of Object.values(data.properties)) {
    if (field.type === "FILE") {
      console.log(`  ${field.code}  ->  ${field.label}`);
    }
  }
}

main().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
