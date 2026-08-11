# shiyui-cosense-mcp

`https://scrapbox.io/shiyui` 専用の read-only Remote MCP Server。

- Cosense は公開 internal API へ匿名 GET
- MCP endpoint は OAuth 必須
- 本人確認は Cloudflare Access for SaaS
- Cloudflare Access policy は許可 email 1件 + One-time PIN
- Cosense の本文・検索結果は保存しない
- Cosense dataは保存せず、OAuth state、identity、code、token、grant、client metadataだけをWorkers KV `OAUTH_KV` に保存

## Tools

| Tool                | 用途                                |
| ------------------- | ----------------------------------- |
| `get_page`          | titleを指定して本文を取得           |
| `search_full_text`  | 通常本文を全文検索                  |
| `search_vector`     | titleと本文中link記法をsemantic検索 |
| `get_related_pages` | 1-hop / 2-hopの関連pageを取得       |

project、origin、URL、HTTP header、credential、file pathはtool引数に含めない。4 toolはすべて `cosense:read` scopeを要求する。

## Requirements

- Node.js 24.11以上
- pnpm 11.16.0
- Cloudflare account
- Cloudflare Access for SaaSを利用できるCloudflare Zero Trust account
- One-time PINを受信するemail address 1件

## Install

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm-workspace.yaml` は `minimumReleaseAge: 10080` を設定し、直接・間接dependencyとも公開後7日未満のversionを拒否する。公開日時がnpm registryにないversionも拒否する。

## Cloudflare Access

### 1. Access for SaaS application

Cloudflare Zero TrustでGeneric OIDCのSaaS applicationを作成する。

- Redirect URI: `https://<worker-origin>/callback`
- PKCE: 有効
- OIDC scope: `openid email profile`
- Identity provider: `One-time PIN` だけを有効化
- Access policy Include: `Emails` で許可email 1件
- Access policy Require: `Login Methods` で `One-time PIN`

One-time PINだけを条件にしない。必ず完全一致のemail条件と組み合わせる。

作成後、次を控える。

- Client ID
- Client secret
- Authorization URL
- Token URL
- JWKS URL

Access OIDC endpointは通常、次の形になる。

```text
https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>/authorization
https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>/token
https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>/jwks
```

### 2. Worker URL

`wrangler.jsonc` の `MCP_SERVER_URL` を公開するMCP URLへ変更する。

```json
{
  "vars": {
    "MCP_SERVER_URL": "https://<worker-origin>/mcp"
  }
}
```

HTTPS、path `/mcp`、queryなし、fragmentなしのURLだけを受け付ける。

### 3. Secrets

本番用secret fileを作成し、値を設定する。

```sh
cp .prod.secrets.example .prod.secrets
openssl rand -hex 32
```

生成値を `.prod.secrets` の `COOKIE_ENCRYPTION_KEY` に設定する。`ALLOWED_EMAIL` はAccess policyと同じemail addressにする。

本番secretを `wrangler.jsonc`、`.prod.secrets.example`、`.dev.vars.example`、Gitへ入れない。`.prod.secrets` とローカル用 `.dev.vars` はGit対象外である。

### 4. Deploy

初回はsecretとWorkerを1回のversionとしてdeployする。

```sh
pnpm exec wrangler whoami
pnpm exec wrangler deploy --secrets-file .prod.secrets
```

以後、secretを変更しないdeployは `pnpm deploy` を使う。

`OAUTH_KV` は初回deploy時にWranglerが自動作成し、namespace IDを `wrangler.jsonc` へ書き戻す。書き戻された差分を確認する。

## Verify

```sh
pnpm check
pnpm exec wrangler deploy --dry-run
```

未認証requestが保護されていることを確認する。

```sh
curl -i https://<worker-origin>/mcp
```

`401` と `WWW-Authenticate` が返り、OAuth protected resource metadataが次を示すことを確認する。

- resource: `https://<worker-origin>/mcp`
- authorization server: `https://<worker-origin>`
- scope: `cosense:read`

OAuth接続では、Access One-time PIN認証後にWorkerの同意画面が表示される。許可後、次を実機確認する。

1. `tools/list` が4 toolだけを返す
2. `get_page` が既存pageと未作成pageを区別する
3. 全文検索とvector検索の対象が異なる
4. 1-hop paginationのcursorが次requestで使える
5. CosenseへAuthorization、Cookie、PAT、Service Account keyを送らない

ChatGPTでtool metadataを更新した場合は、app設定からMCP connectionをrefreshし、新しいconversationで確認する。

## Local test

`.dev.vars.example` を `.dev.vars` へコピーし、test用値へ置き換える。

```sh
cp .dev.vars.example .dev.vars
pnpm dev
```

fixture testは外部Cosense、Cloudflare Access、ChatGPTへ接続しない。
`.dev.vars.example` の `MCP_SERVER_URL` はlocalhost用である。AccessとChatGPTを含むOAuth全体はdeploy後のHTTPS URLで確認する。

## Token and secret lifecycle

| 対象                               | 期限・更新                                    |
| ---------------------------------- | --------------------------------------------- |
| Access One-time PIN                | 10分、1回使用。新しいPIN発行で以前のPINは無効 |
| MCP access token                   | 1時間                                         |
| MCP refresh token / grant          | 30日                                          |
| OAuth bridge state / consent state | 10分、1回使用                                 |
| Access client secret               | Access側でrotate後、Worker secretを更新       |
| `COOKIE_ENCRYPTION_KEY`            | 手動rotate。進行中の10分stateだけが無効       |

`ALLOWED_EMAIL` を変更して再deployすると、以前のemailへ発行したtokenは拒否される。Access policyだけを変更した場合、既発行のMCP grantは即時失効しない。全grantを失効する場合は、新しい空のKV namespaceへ `OAUTH_KV` bindingを切り替えて再deployする。旧namespaceは確認後に削除する。

## Data and errors

- Cosense APIは `GET` と `cache: "no-store"` だけを使用
- 一時stateにはOAuth request、PKCE verifier、nonce、`sub`、email、name、scope、CSRFを最大10分保存する
- OAuth Providerの `props` は暗号化されるが、grant metadataのemail labelを含め `OAUTH_KV` 全体を機密データとして扱う
- responseにpage author、email、line ID、raw API responseを含めない
- upstream error bodyをtool resultへ含めない
- OAuth code、token、Cookie、page本文、queryをlogしない
- vector `score` の絶対thresholdを設けない
- full-text / vectorの総件数やindex反映時間を保証しない
- Cosense internal APIは予告なく変更される可能性がある

調査根拠と非採用機能は [docs/research.md](docs/research.md) を参照する。
