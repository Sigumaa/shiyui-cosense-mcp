# Cosense write設計

確認日: 2026-08-14（JST）

## 対象

- origin: `https://scrapbox.io`
- project: `shiyui`
- credential: Cloudflare Secret `COSENSE_PAT`
- 公開操作: page新規作成、既存page末尾追記、既存page更新、project内link一括置換

任意project、任意URL、SID、WebSocket、Service Account、raw line operationは対象外とする。

## 公式CLIの確認結果

確認対象は `@helpfeel/cosense-cli` v1.11.0、tag commit `037afc4526a187810b03e34c81583722203335d0`。

- [package.json](https://github.com/helpfeel/cosense-cli/blob/v1.11.0/package.json)
- [PAT request](https://github.com/helpfeel/cosense-cli/blob/v1.11.0/src/lib/request.ts#L41-L83)
- [previewEdit](https://github.com/helpfeel/cosense-cli/blob/v1.11.0/src/commands/previewEdit.ts#L323-L374)
- [submitEdit](https://github.com/helpfeel/cosense-cli/blob/v1.11.0/src/commands/submitEdit.ts#L46-L60)
- [編集時の復旧方針](https://github.com/helpfeel/cosense-cli/blob/v1.11.0/skills/cosense/edit-page.md#L130-L180)
- [replaceLinks](https://github.com/helpfeel/cosense-cli/blob/v1.11.0/src/commands/replaceLinks.ts#L35-L50)

公式CLIはPATを `x-personal-access-token` で送る。writeは次の2段階である。

```text
POST /api/pages/v2/{project}/page-edit-for-ai/preview
POST /api/pages/v2/{project}/page-edit-for-ai/submit
```

preview body:

```json
{
  "pageId": "既存pageだけで指定",
  "changes": [
    {
      "_insert": "_end",
      "lines": { "id": "24桁hex", "text": "追加行" }
    }
  ]
}
```

submit body:

```json
{ "previewId": "preview responseのID" }
```

`previewId` は5分で失効し、submit時にconsumeされる。submit後、失効後、consume済み、別userのpreviewは404になる。409 `NotFastForward` はpreview後のpage更新、409 `DuplicateTitle` は新規page名の競合を表す。公式手順は、古いpreviewの再送や自動retryをせず、pageを読み直してpreviewからやり直す。

タイトル変更はtitle行への `_update`、本文削除はlineへの `_delete` で行える。link一括置換だけはpreview / submitとは別の次のAPIを使う。

```text
POST /api/pages/{project}/replace/links
```

bodyは `{ "from": "旧title", "to": "新title" }`。pageタイトル自体は変更せず、project内の `[title]`、`#title`、`[title.icon]` を置換する。500では一部pageだけ反映済みの場合があるが、同じ引数の再実行では未置換pageだけが対象になる。

## 公開tool

### `create_page`

入力:

```json
{ "title": "山形", "text": "行きたい場所\n[候補のURL]" }
```

同名pageの存在をPages API v2で確認する。実pageが存在すれば失敗し、追記へ切り替えない。不存在時だけtitle行とtextをpreviewする。preview内容が入力と一致し、同名pageがまだ存在しないことを再確認してからsubmitする。

### `append_to_page`

入力:

```json
{
  "title": "山形",
  "text": "\n行きたい場所を追加",
  "expectedCommitId": "get_pageが返したcommitId"
}
```

実行前にpageの `pageId` と `commitId` を取得する。`expectedCommitId` と不一致、page不存在、rename時は失敗する。preview後にも同じpageとcommitであることを確認してからsubmitする。別操作へのfallbackは行わない。

### `update_page`

入力:

```json
{
  "title": "山形",
  "expectedCommitId": "get_pageが返したcommitId",
  "body": "行きたい場所\n[候補のURL]",
  "newTitle": "山形旅行"
}
```

`body` はtitle行を除く完成後の本文とする。省略時は現在の本文を維持し、空文字は本文行をすべて削除する。`newTitle` は任意で、`body` または `newTitle` の少なくとも一方を必須とする。

現在のline IDをclient内部で保持したまま、変更のある行だけを `_update` / `_insert` / `_delete` へ変換する。`expectedCommitId` を実行前とpreview後に検証し、previewのtitle・persistent・全line ID・全textが指定した完成形と完全一致した場合だけsubmitする。変更がない場合はsubmitせず成功を返す。

### `replace_links`

入力:

```json
{ "fromTitle": "山形", "toTitle": "山形旅行" }
```

固定projectへの1 POSTでlinkを一括置換する。previewはなく、複数pageへ影響するため、単一page更新とは別tool・別承認にする。タイトル変更後も自動実行せず、`update_page` のsubmit responseが返した実titleを `toTitle` に使う。

競合せず成功するpage editは `GET → preview → GET → submit` の最大4 requestとする。変更なしのupdateは1 GET、`replace_links` は1 POSTである。競合時は途中で停止する。preview / submitは各1回だけ実行し、preview ID、page ID、line IDをMCP出力へ返さない。

## 競合と二重実行

- createの再実行は同名pageの存在確認で停止する
- appendの再実行は古い `expectedCommitId` で停止する
- updateの再実行は変更後のcommitに対する古い `expectedCommitId` で停止する
- 409では自動preview、自動submit、操作の切り替えを行わない
- submit 404では期限切れ、consume済み、他userのpreviewを区別せず、pageを確認してから新しい操作を組み立てる
- submitのnetwork error、timeout、2xx response不正、5xxは、commit済みか断定できないため結果不明として扱う
- 結果不明時はwriteを再実行せず、先に `get_page` で反映状態を確認する
- `replace_links` のnetwork error、5xx、2xx response不正は一部反映済みの可能性がある。同じtitleの組だけは安全に再実行できるため、その旨を区別して返す

独自idempotency storeは追加しない。直前状態の確認、Cosenseのpreview競合検知、one-shot preview IDを利用する。

## MCP annotations

create / append:

```json
{
  "readOnlyHint": false,
  "destructiveHint": false,
  "idempotentHint": false,
  "openWorldHint": true
}
```

update / replace links:

```json
{
  "readOnlyHint": false,
  "destructiveHint": true,
  "idempotentHint": true,
  "openWorldHint": true
}
```

作成と追記は既存dataを削除・上書きしないため `destructiveHint` はfalseとする。updateは既存本文の置換・削除、replace linksは複数pageの変更を含むためtrueとする。updateは完成形とcommit条件を指定し、replace linksは同じtitleの組を再実行しても置換済みpageへ追加作用しないため `idempotentHint` はtrueとする。すべて外部Cosenseへ書き込むため `openWorldHint` はtrueである。annotationsはclient向けのhintであり、認証、入力検証、ユーザー承認の代替にはしない。[OpenAI tool annotations](https://developers.openai.com/plugins/reference#annotations)

`confirmed: true` のような入力は人間の承認を証明しないため設けない。tool descriptionで対象と正確な変更内容の承認後だけ呼ぶよう指示し、ChatGPT側のwrite確認とCloudflare Accessを利用する。

## Cosense記法とproject内の慣習

公式CLIは単体commandだけでなく、編集前に対象pageを読み、project内の見出し・indent・空行・icon・linkのstyleへ合わせるAgent Skillも提供する。このMCPではproject固有の書き方・記法・編集方針をCosenseの [`cosenseの書き方`](https://scrapbox.io/shiyui/cosense%E3%81%AE%E6%9B%B8%E3%81%8D%E6%96%B9) に置き、正本とする。

MCPのserver descriptionには、pageの作成・追記・更新前に `get_page` で正本を読むことと、通常のreadでは不要であることだけを記載する。ルール本体はコードやREADMEへ複製しない。承認対象、本文全置換、project-wide link置換、retry条件は各tool descriptionとclient実装で別に担保する。

- [公式CLI Agent Skill: edit-page](https://github.com/helpfeel/cosense-cli/blob/v1.11.0/skills/cosense/edit-page.md)
- [Cosense Help: ブラケティング](https://scrapbox.io/help-jp/%E3%83%96%E3%83%A9%E3%82%B1%E3%83%86%E3%82%A3%E3%83%B3%E3%82%B0)

## 入力と通信境界

- title: trim後1–500文字、`.` / `..`、CR / LF / NULを拒否
- text: 空白だけ、NULを拒否。最大10,000 UTF-16 code units、100行
- body: NULを拒否。空文字を許可し、最大10,000 UTF-16 code units、100行
- expectedCommitId: trim後1–500文字
- 新規line ID: Web Cryptoで生成する12 byte、24桁hex
- request timeout: 15秒
- `cache: "no-store"`
- `redirect: "manual"`。3xxを追跡しない
- PAT、upstream error body、preview IDをresultとlogへ含めない
- 自動retry、polling、background処理、Cosense本文の永続化を行わない

## 公式CLIとの差分

| 項目       | 公式CLI                                                    | このMCP                                  |
| ---------- | ---------------------------------------------------------- | ---------------------------------------- |
| project    | project URLを引数で指定                                    | `shiyui` 固定                            |
| credential | PATまたはService Account                                   | PATのみ                                  |
| 公開操作   | create / insert / replace / delete / rename / replaceLinks | create / append / update / replace links |
| 編集指定   | line IDを含むoperation                                     | appendまたはpage本文の完成形             |
| preview ID | command間で利用者が渡す                                    | tool内部だけで利用                       |
| 競合前提   | Agent Skillの手順で再read                                  | commitIdを必須にしclientでも2回検査      |
| 入力上限   | 主にCosense側validation                                    | 文字数・行数・生成change数をMCPでも制限  |
| redirect   | JSON requestはfetch既定                                    | manual no-follow                         |
| response   | plain text中心                                             | Zod検証したstructured content            |

公式CLIのraw operation、preview ID受け渡し、任意projectは公開しない。MCPでは会話上の目的に合わせた4 toolへまとめ、タイトル変更とproject-wide link置換は非atomicな別操作として分離する。
