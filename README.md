# shiyui-cosense-mcp

`https://scrapbox.io/shiyui` 専用の Remote MCP Server。

- Cosense Personal Access Token（PAT）を必須とし、Cloudflare Secret `COSENSE_PAT` に保存
- `shiyui` 固定のCosense requestへ `x-personal-access-token` を送信
- PATが未設定または空ならCosenseへ接続せず失敗
- Public / Private pageを同じ認証経路で取得
- MCPはCloudflare Access Managed OAuthで保護
- 6つのread toolと、用途を分けた4つのwrite toolを公開
- writeは公式CLIと同じpage edit APIとreplace links APIを使用し、任意project、任意URL、cacheは持たない

## Tools

| Tool                | 用途                                 |
| ------------------- | ------------------------------------ |
| `get_page`          | titleを指定して本文を取得            |
| `search_full_text`  | 通常本文を全文検索                   |
| `search_vector`     | titleと本文中link記法をsemantic検索  |
| `get_related_pages` | 1-hop / 2-hopの関連pageを取得        |
| `list_pages`        | page metadataを一覧取得              |
| `get_page_changes`  | 1 pageの変更履歴を取得               |
| `create_page`       | pageを新規作成                       |
| `append_to_page`    | 既存pageの末尾へtextを追記           |
| `update_page`       | 既存pageの本文更新・タイトル変更     |
| `replace_links`     | project内の旧titleへのlinkを一括置換 |

project、origin、URL、HTTP header、credential、file pathはtool引数に含めない。

`list_pages` は `sort`、1–20の `limit`、明示的な `skip` を受け取り、一覧APIへの1 GETだけで完結する。page detailのN+1取得と自動paginationは行わない。

`get_page_changes` は `get_page` が返す `pageId` と任意の `commitId` を受け取る。対象pageのcommitsとactor名解決用のproject usersを2 GETで並列取得し、他page、page本文、関連pageへ広げない。最新50件の変更に限定し、変更前後のtextは各500文字までとする。actorはnameだけを返し、email、user ID、line IDは返さない。

### Write

write toolは、対象と正確な変更内容についてユーザーが書き込みを承認した後だけ呼ぶ。

MCP server-level instructionsで、書き込み案の作成前に既存pageまたは類似pageを確認し、project内のstyleを優先するようclientへ伝える。本文はMarkdownではなくCosense記法とし、行頭の半角spaceまたはtabで箇条書きと階層を作り、段落間に空行を置き、意図した内部linkを `[Page Title]` で記述する。操作固有の削除・競合・再実行条件は各tool descriptionに置く。

- `create_page` は同名の実pageがある場合に失敗する。既存pageへの追記へ切り替えない
- `append_to_page` は直前の `get_page` が返した `commitId` を `expectedCommitId` として必須にする
- `update_page` は直前の `get_page` が返した `commitId` を必須にし、title行を除く完成後の本文を `body` に指定する。`body` の省略は本文維持、空文字は本文全削除を表す。`body` を指定した場合、含めなかった既存行は削除される。任意の `newTitle` でタイトルも変更できる
- `replace_links` はproject内の `[title]`、`#title`、`[title.icon]` を一括置換する。pageタイトルは変更せず、previewも行わないため、影響範囲を別に承認してから呼ぶ
- page編集はpageが不存在、rename済み、または更新済みなら失敗する。最新pageを読み直し、内容を再確認してから実行する
- create / appendのtextとupdateのbodyは最大10,000文字・100行。NULを拒否し、create / appendでは空白だけのtextも拒否する
- create / append / updateは1 call内で `page-edit-for-ai/preview` と `submit` を各1回までとし、自動retryしない
- submit結果が不明な場合は同じwriteを再実行せず、先に `get_page` で反映状態を確認する
- タイトル変更後のlink置換は自動実行しない。`update_page` が返した実際のtitleを確認し、別の承認後に `replace_links` を呼ぶ
- `replace_links` の通信失敗または5xxは一部だけ反映済みの可能性がある。同じ `fromTitle` / `toTitle` だけを再実行できる

preview ID、line ID、page ID、project、origin、credentialはwrite toolの引数に含めない。raw operationも公開しない。

## Requirements

- Node.js 24.11以上
- pnpm 11.16.0
- Cloudflare Workers Free plan
- Cloudflare Zero Trust Free plan
- Cosense Personal Access Token
- One-time PINを受信するemail address 1件

## Install

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm-workspace.yaml` はdependencyのminimum release ageを7日に設定する。

## Cosense PAT

PATは `https://scrapbox.io/settings/personal-access-tokens` で発行する。README、`wrangler.jsonc`、example file、Gitには保存しない。

localでは、Git管理外の `.dev.vars` を作成して実値を設定する。

```sh
cp .dev.vars.example .dev.vars
```

```dotenv
COSENSE_PAT=replace-with-personal-access-token
```

CloudflareにはSecretとして登録する。

```sh
npx wrangler secret put COSENSE_PAT
```

PATが未設定または空の場合はfail closedとし、匿名requestへfallbackしない。Cosenseが `401` または `403` を返した場合は認証失敗として扱い、PAT、upstream response body、statusごとの意味をclientへ返さない。

## Cloudflare Access

1. Cloudflare Zero TrustにOne-time PIN identity providerを追加する。
2. Workerの公開hostname全体を対象にSelf-hosted Access applicationを作成する。
3. Allow policyのIncludeを本人のemail 1件にし、利用可能なidentity providerをOne-time PINだけにする。
4. applicationでManaged OAuthとDynamic Client Registrationを有効にする。
5. DCRのredirect URIにChatGPT管理画面で表示されたcallback URIを登録する。
6. localhost clientとloopback clientを無効にする。
7. Application Audience tagとteam domainを `wrangler.jsonc` に設定する。
8. Preview URLは使用しない。`wrangler.jsonc` で `preview_urls: false` を明示し、Cloudflare上でも無効になっていることを確認する。

```json
{
  "vars": {
    "TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
    "POLICY_AUD": "<application-audience-tag>"
  }
}
```

Access for SaaS application、OIDC client ID / secret、Worker callback、custom scopeは使用しない。

## 課金

- Workers FreeとZero Trust Freeだけを使用し、有料planへupgradeしない
- KV、Durable Objects、D1、R2、Queues、Workers AIは使用しない
- readは1 tool callあたり最大2 request。page writeは最大4 request、`replace_links` は1 requestで、自動retryは行わない
- Workers Freeの1日100,000 requestを超えた場合は処理が失敗し、従量課金には移行しない

## Deploy

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm check
pnpm exec wrangler deploy --dry-run
pnpm run deploy
```

ChatGPT Developer modeへ次を登録する。

```text
https://<worker-origin>/mcp
```

初回接続でOne-time PIN認証を行い、10 toolの一覧と1回のread callを確認する。write確認は内容と対象を明示して別途行う。

## Data boundary

- readはallowlist済みの `GET`、page writeは対象確認用の `GET` とpreview / submit `POST`、link置換は固定projectのreplace links `POST`だけを使用し、すべて `cache: "no-store"` とする
- 全Cosense requestへ `x-personal-access-token` を付与し、Public / Privateで分岐しない
- MCP responseも `Cache-Control: no-store`
- responseにemail、user ID、line ID、raw API responseを含めない。変更履歴のactorはnameだけを返す
- `list_pages` は1 GETだけとし、N+1取得、全件走査、自動paginationを行わない
- `get_page_changes` は対象pageのcommitsとactor名解決用usersの2 GETだけとし、他pageへ広げない
- writeは新規作成、末尾追記、完成形によるpage更新、link一括置換に限定し、同名存在またはcommit不一致から別操作へfallbackしない
- 自動retry、polling、background同期、事前indexを行わない
- PAT、OAuth token、Access assertion、page本文、queryをlogしない
- `401` / `403` はtokenとupstream bodyを含まない認証失敗として返す
- Cosense internal APIとPAT headerの利用方法は予告なく変更される可能性がある

read調査の履歴は [docs/research.md](docs/research.md)、writeの設計根拠は [docs/write-design.md](docs/write-design.md) を参照する。
