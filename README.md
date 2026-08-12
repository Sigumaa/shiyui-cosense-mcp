# shiyui-cosense-mcp

`https://scrapbox.io/shiyui` 専用の read-only Remote MCP Server。

- Cosense は公開 internal API へ匿名 GET
- MCP は Cloudflare Access Managed OAuth で保護
- Access policy は許可 email 1件 + One-time PIN
- Worker は `Cf-Access-Jwt-Assertion` の署名、issuer、audience、有効期限を検証
- KV、OAuth secret、Cosense credential、本文 cache は使用しない

## Tools

| Tool                | 用途                                |
| ------------------- | ----------------------------------- |
| `get_page`          | titleを指定して本文を取得           |
| `search_full_text`  | 通常本文を全文検索                  |
| `search_vector`     | titleと本文中link記法をsemantic検索 |
| `get_related_pages` | 1-hop / 2-hopの関連pageを取得       |

project、origin、URL、HTTP header、credential、file pathはtool引数に含めない。

## Requirements

- Node.js 24.11以上
- pnpm 11.16.0
- Cloudflare account
- Cloudflare Zero Trust account
- One-time PINを受信するemail address 1件

## Install

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm-workspace.yaml` はdependencyのminimum release ageを7日に設定する。

## Cloudflare Access

1. Cloudflare Zero TrustにOne-time PIN identity providerを追加する。
2. Workerの公開hostname全体を対象にSelf-hosted Access applicationを作成する。
3. Allow policyのIncludeを本人のemail 1件にし、利用可能なidentity providerをOne-time PINだけにする。
4. applicationでManaged OAuthとDynamic Client Registrationを有効にする。
5. DCRのredirect URIにChatGPT管理画面で表示されたcallback URIを登録する。
6. Application Audience tagとteam domainを `wrangler.jsonc` に設定する。

```json
{
  "vars": {
    "TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
    "POLICY_AUD": "<application-audience-tag>"
  }
}
```

Access for SaaS application、OIDC client ID / secret、Worker callback、custom scopeは使用しない。

## Deploy

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm check
pnpm exec wrangler deploy --dry-run
pnpm deploy
```

ChatGPT Developer modeへ次を登録する。

```text
https://<worker-origin>/mcp
```

初回接続でOne-time PIN認証を行い、4 toolの一覧と1回のread callを確認する。

## Data boundary

- Cosense requestは `GET` と `cache: "no-store"` だけを使用
- MCP responseも `Cache-Control: no-store`
- responseにpage author、email、line ID、raw API responseを含めない
- upstream error bodyをtool resultへ含めない
- OAuth token、Access assertion、page本文、queryをlogしない
- Cosense internal APIは予告なく変更される可能性がある

調査根拠と非採用機能は [docs/research.md](docs/research.md) を参照する。
