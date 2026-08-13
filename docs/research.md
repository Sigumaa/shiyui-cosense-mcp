# Cosense read-only Remote MCP 調査報告

調査日: 2026-08-12（JST）

設計更新: 2026-08-13（JST）

状態: Cosense Personal Access Token（PAT）を必須とする実装へ更新し、既存4 toolについてPublicの `shiyui` に対するPAT付きlocal live smokeを完了。`list_pages` と `get_page_changes` を加えた6-tool版もProductionへdeploy済みだが、追加2 toolのlive smokeは未実施。Cloudflare Access設定とMCP OAuth構成は変更していない。ChatGPTからのread callとPrivate projectでの確認も未実施。

## 結論

2026-08-12には、`shiyui` のPublic dataについて匿名GETで次の機能を観測できた。

- Pages API v2 による現在のページ本文
- 全文検索
- Cosense 自身のタイトル・リンク記法ベクトル検索
- 1-hop / 2-hop の関連ページ取得と絞り込み

この匿名観測はendpoint調査時のbaselineとしてだけ残す。現行設計はPublic / Privateを分岐せず、6 toolから発生するすべての `shiyui` 固定GETにPATを送る。Public dataが匿名で取得できる場合も、匿名fallbackは行わない。

現行MCPは、次の6 toolに限定する。

1. `get_page`
2. `search_full_text`
3. `search_vector`
4. `get_related_pages`
5. `list_pages`
6. `get_page_changes`

PATはCloudflare Secret `COSENSE_PAT` にだけ保存し、各Cosense GETへ `x-personal-access-token` として付与する。未設定またはtrim後に空ならupstreamへ接続せずfail closedとする。upstreamの `401` / `403` はどちらも安全な認証失敗へ変換し、PATとupstream bodyを返さない。PAT headerの利用はHelpfeel公式CLIの現行実装に基づくが、安定した公開API契約やstatusごとの意味としては扱わない。[request implementation](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/lib/request.ts#L44-L78)

MCP endpoint自体は引き続きCloudflare Access Managed OAuthで一人だけに制限する。WorkerはAccessが付与する `Cf-Access-Jwt-Assertion` を検証してからstateless `createMcpHandler()`を実行する。Cosense PAT以外のcredential、OAuth secret、MCP session、Durable Objects、D1、R2、独自cache、同期jobは不要である。

本人確認は許可email 1件 + One-time PINのAccess policyに委譲する。Workerは署名、issuer、Application Audience、有効期限だけを検証し、同じemail判定やcustom scopeを重複実装しない。

Cloudflare Dashboardで、Workers Free、Zero Trust Teams Free Base、通常のFree Planだけがactiveであることを2026-08-12に確認した。Workers Paidへupgradeせず、KV、Durable Objects、D1、R2、Queues、Workers AIも使わない。Workers Freeは1日100,000 requestまでで、上限超過後は追加requestが失敗するため従量課金へ移行しない。Cosenseへのsubrequestも課金対象ではなく、1 tool callあたり最大2件、自動retryなしとする。[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) [Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/)

## 調査範囲と根拠

ソースの README だけでなく、command 登録、HTTP 実装、認証解決、レスポンス加工、テスト、公式 Help、公式 Web client、実通信まで確認した。

| 対象                                                                                                                                | 固定した版                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`worldnine/scrapbox-cosense-mcp`](https://github.com/worldnine/scrapbox-cosense-mcp/tree/d4f649f3c18383d748cbda73b9181c59c0f2d8ce) | `d4f649f3c18383d748cbda73b9181c59c0f2d8ce`（v0.9.0 系）                |
| [`helpfeel/cosense-cli`](https://github.com/helpfeel/cosense-cli/tree/70c62293e3755a43f87e58e8dc59e9e896afcbcb)                     | 基礎調査: `70c62293e3755a43f87e58e8dc59e9e896afcbcb`                   |
| [`helpfeel/cosense-cli`](https://github.com/helpfeel/cosense-cli/tree/e06bc890958cfe8d1b6fe932db06c35eb8c8577d)                     | 追加2 tool: `e06bc890958cfe8d1b6fe932db06c35eb8c8577d`（v1.10.1）      |
| Cosense 公式 Help / 本番 API / Web client                                                                                           | 2026-08-12 に確認                                                      |
| MCP specification                                                                                                                   | [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) |
| Cloudflare Agents / Access Managed OAuth                                                                                            | 2026-08-12 の公式 documentation と current example                     |
| OpenAI ChatGPT Developer mode / plugin documentation                                                                                | 2026-08-12 に確認                                                      |

Cosense は公式に、掲載 API を内部 API とし、予告なく変更する可能性があると明記している。そのため本報告では、次の3種類を区別する。

- 公式 Help に記述された仕様
- Helpfeel 公式 CLI / Web client が現在使用する実装
- 2026-08-12 の本番環境での観測値

安定した公開 API 契約として扱わない。[Cosense API Help](https://scrapbox.io/help-jp/API)

実装環境はmacOS 26.5.2 arm64、Node.js 24.15.0、npm 11.12.1、pnpm 11.16.0、Homebrew 6.0.12、Git 2.50.1を確認した。Wranglerはglobal未導入なので、repositoryのdev dependencyとしてversion固定して使う。

## 過去の匿名実通信

以下は2026-08-12のendpoint調査時の観測であり、現行MCPの認証経路ではない。`curl -q` を使い、Cookie、`connect.sid`、Authorization、PAT、Service Account key、curl 設定を付けずに `https://scrapbox.io/shiyui/` のデータを取得した。レスポンス本文は保存していない。

| 機能                | GET endpoint                                                 | status | 当時の観測                                         |                        現行tool |
| ------------------- | ------------------------------------------------------------ | -----: | -------------------------------------------------- | ------------------------------: |
| ページ一覧          | `/api/pages/shiyui/?limit=10&skip=0&sort=linked`             |    200 | 件数、page metadata、10件の実ページ                |                            採用 |
| Pages API v2        | `/api/pages/v2/shiyui/日記`                                  |    200 | `commitId`、12行の本文、links、files、page metrics |                            採用 |
| Pages API v1        | `/api/pages/shiyui/日記`                                     |    200 | 本文と旧 `relatedPages` shape                      |                          不採用 |
| 全文検索            | `/api/pages/shiyui/search/query?q=日記`                      |    200 | 11件、exact title、一致行、Elasticsearch metadata  |                            採用 |
| vector              | `/api/pages/shiyui/search/vector/titles?q=日記`              |    200 | 3件、`score`、`exists`                             |                            採用 |
| 1-hop               | `/api/pages/v2/shiyui/日記/links1hop`                        |    200 | 12件、pagination                                   |                            採用 |
| 2-hop               | `/api/pages/v2/shiyui/日記/links2hop`                        |    200 | 1件、pagination                                    |                            採用 |
| 1-hop search        | `.../links1hop?search=2026`                                  |    200 | 絞り込み6件、match metadata                        |                            採用 |
| 2-hop search        | `.../links2hop?search=2026`                                  |    200 | 正常応答、該当0件                                  |                            採用 |
| Project users       | `/api/projects/shiyui/users`                                 |    200 | 公開 user map                                      | 変更履歴のactor名解決だけに採用 |
| Smart Context 1-hop | `/api/smart-context/export-1hop-links/shiyui.txt?title=日記` |    401 | `NotLoggedInError`                                 |                          不採用 |
| Smart Context 2-hop | `/api/smart-context/export-2hop-links/shiyui.txt?title=日記` |    401 | `NotLoggedInError`                                 |                          不採用 |
| ページ変更履歴      | `/api/commits/shiyui/{pageId}`                               |    401 | `NotLoggedInError`                                 |                            採用 |
| file metadata       | `/api/gcs/{public-page-file-id}/info`                        |    401 | `NotLoggedInError`                                 |                          不採用 |
| public file本体     | `/files/{public-page-file-id}.jpg`                           |    200 | `image/jpeg`、179,637 bytes。bodyは保存せず破棄    |                          不採用 |

当時の匿名レスポンスには、当時の4 toolに必要な本文、候補 title、score、match 行、関連 page metadata が含まれていた。認証成功側の実通信は行っていない。表の401はその時点で匿名不可だったことだけを示し、PATの正式仕様や `401` と `403` の意味を示すものではない。現行MCPは表のstatusにかかわらず全GETへPATを送る。

## 既存 `scrapbox-cosense-mcp`

現行 source は9 toolを持つ。[tool registration](https://github.com/worldnine/scrapbox-cosense-mcp/blob/d4f649f3c18383d748cbda73b9181c59c0f2d8ce/src/index.ts#L160-L398)

| tool                | 種別  | endpoint / 処理                                              |       SIDなし |
| ------------------- | ----- | ------------------------------------------------------------ | ------------: |
| `get_page`          | read  | `GET /api/pages/{project}/{title}`                           | public を想定 |
| `list_pages`        | read  | list GET 後、各 page を detail GETする N+1                   | public を想定 |
| `search_pages`      | read  | `GET /api/pages/{project}/search/query?q=...`                | public を想定 |
| `get_smart_context` | read  | `GET /api/smart-context/export-{1,2}hop-links/{project}.txt` |          不可 |
| `get_page_url`      | local | URL生成のみ                                                  |            可 |
| `create_page`       | write | WebSocket patch。URL-only modeもある                         |   writeは不可 |
| `insert_lines`      | write | WebSocket patch                                              |          不可 |
| `edit_lines`        | write | WebSocket patch                                              |          不可 |
| `delete_page`       | write | opt-in登録後、全行削除 patch                                 |          不可 |

GET 系は `COSENSE_SID` が存在するときだけ `Cookie: connect.sid=...` を付け、未設定なら Cookie header 自体を送らない。[page/list/search implementation](https://github.com/worldnine/scrapbox-cosense-mcp/blob/d4f649f3c18383d748cbda73b9181c59c0f2d8ce/src/cosense.ts#L97-L156) [Smart Context](https://github.com/worldnine/scrapbox-cosense-mcp/blob/d4f649f3c18383d748cbda73b9181c59c0f2d8ce/src/cosense.ts#L457-L490)

読み取り結果は Markdown 風 text に加工される。`get_page` は本文、links、作成・更新 metadata、creator/editor 等を連結し、list/search は description や match snippet を整形する。Smart Context の `compact` は `<PageList>` 部分だけを抽出する。

アプリケーションの page/search cache はない。起動時に最大100 pageの resource snapshotを一度作るが、resource readとtool callは再取得する。`list_pages` は一覧に加えて N detail request を実行するため、本用途には重い。

MCP transport は stdio のみであり、Cloudflare Remote MCPへそのまま載せられない。[stdio transport](https://github.com/worldnine/scrapbox-cosense-mcp/blob/d4f649f3c18383d748cbda73b9181c59c0f2d8ce/src/index.ts#L401-L410) 書き込み実装、古い SDK、N+1、source と docs の差異も抱えるためforkしない。SIDなしで成立した公開GETは過去のendpoint調査だけに利用し、現行のcredential方式はHelpfeel公式CLIを参照する。

## Helpfeel 公式 `cosense-cli`

CLIのcommand登録とrequest処理は固定commit `70c6229` を確認した。[command registry](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/src/cli.ts)

### Read / auth関連 command

read-only commandのHTTP requestはGETである。多くの command は本体 GET と別に `/api/projects/{project}/users` を取得し、user ID と timestamp を人間向けに補完する。この補完 request が失敗すると本体も失敗する。今回のMCPでは、変更履歴のactor名を返す `get_page_changes` だけがusers GETを使用する。`list_pages` と既存4 toolには追加しない。

表の「credential-aware」は公式CLI自身の挙動を表す。CLIはcredentialが見つからなければheaderなしでrequestできるが、このMCPはそのfallbackを採用しない。Public / Privateの区別なく `COSENSE_PAT` を必須にする。

| command              | endpoint / 合成処理                                          | 主な引数                       | 認証・加工                                                            |
| -------------------- | ------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------- |
| `whoami`             | `/api/users/me`                                              | origin                         | origin PAT必須、timestamp補完                                         |
| `listProjects`       | `/api/projects`                                              | origin                         | origin PAT必須、updated順                                             |
| `readProjectMembers` | `/api/projects/{project}/users`                              | project URL                    | credential-aware。`shiyui`匿名200、user/member JSON                   |
| `readPage`           | `/api/pages/v2/{project}/{title}` + users                    | page URL                       | credential-aware。page/user/timestamp JSON、未作成pageの仮IDを除去    |
| `browsePage`         | Page v2 + users + links1hop + file/Gyazo metadata            | page URL                       | credential-aware。AI向けMarkdown、Infobox、telomere、related          |
| `browsePageChanges`  | `/api/commits/{project}/{pageId}[?head=...]` + users         | project URL、pageId、since     | credential-aware。`shiyui`匿名401、line変更を統合したMarkdown         |
| `listPages`          | `/api/pages/{project}/?sort=&limit=&skip=&filter...` + users | sort、limit、skip、icon filter | offset 1回、user/timestamp補完。既定100、現行serverは最大1000に丸める |
| `searchFullText`     | `/api/pages/{project}/search/query?q=&op=&sort=` + users     | query、OR、sort                | 一致行、words、metadataをJSON化                                       |
| `searchVector`       | `/api/pages/{project}/search/vector/titles?q=` + users       | query                          | score順JSON                                                           |
| `list1hopLinks`      | Page v2 + `/links1hop` + users                               | page URL                       | outgoing/incoming/bidirectionalをローカル計算                         |
| `list2hopLinks`      | `/links2hop` + users                                         | page URL                       | user/timestamp補完                                                    |
| `search1hopLinks`    | Page v2 + `/links1hop?search=&op=` + users                   | page URL、query、OR            | relationをローカル計算                                                |
| `search2hopLinks`    | `/links2hop?search=&op=` + users                             | page URL、query、OR            | user/timestamp補完                                                    |
| `browseRelatedPages` | Page v2 + links1hop + links2hop                              | page URL                       | rank、stack、Infobox tableをMarkdown/TSV化                            |
| `readFileInfo`       | `/api/gcs/{fileId}/info`                                     | file URL、project option       | origin PATを選択、またはproject指定時SA。credentialなしも送信可       |
| `downloadFile`       | `/files/{fileId}[?type=thumbnail]`                           | file URL、output path          | credential-awareなremote read + local atomic上書き                    |

主要 source: [readPage](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/src/commands/readPage.ts#L83-L90)、[searchFullText](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/src/commands/searchFullText.ts#L109-L118)、[searchVector](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/src/commands/searchVector.ts#L62-L70)、[related helper](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/src/lib/relatedPages.ts#L9-L14)、[listPages](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/listPages.ts#L132-L153)、[browsePageChanges](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/browsePageChanges.ts#L190-L230)。いずれもcredentialをrequest helperへ渡す実装であり、PAT自体の安定した公開API契約を示すものではない。

### 非read command

- `login`: `~/.cosense/settings.json` に PAT / Service Account key を保存するローカル認証操作。
- `previewEdit`: `/api/pages/v2/{project}/page-edit-for-ai/preview` へ POSTし、5分のserver-side preview stateを作る。
- `submitEdit`: `/api/pages/v2/{project}/page-edit-for-ai/submit` へ POSTし、pageをcommitする。

これらの code と dependency は現行MCPに含めない。

### CLIの認証・request処理

`requestJson` はcredentialに応じて次のいずれかを送る。[request implementation](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/lib/request.ts#L44-L78)

- PAT: `x-personal-access-token`
- Service Account: `x-service-account-access-key`

公式CLIのproject commandは `COSENSE_PAT` を最優先に解決する。[settings resolution](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/src/lib/settings.ts#L238-L264) CLIにあるService Account、origin PAT、匿名へのfallbackはこのMCPに含めない。Cookie、retry、HTTP cache、page/search cache、自動paginationも含めない。

CLIは source-levelの型を期待するが、runtime response schemaを検証しない。このMCPでは、使用fieldだけを小さく検証し、API shapeが変わったら明確な upstream error にする。

### AI Agent向けSkillから得られる設計知見

公式Skillは、themeを探す際にvector queryを複数の言い換えで試し、候補を選んでからpage本文を読み、必要な場合だけ1/2-hopへ深める手順を勧めている。vectorはtitleとlink記法だけなので、本文語を探す場合はfull-textを使い分ける。すべての関連pageを読むのではなく、description、relation、pageRankから選ぶ。[read-page workflow](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/skills/cosense/read-page.md)

通常の閲覧はAI向けに整形する `browsePage`、edit anchorや機械処理が必要な場合だけraw寄りの `readPage` という境界も明記されている。今回のMCPはwriteを持たないため、`get_page` は本文とfreshness識別子だけを返し、line IDを返さない。変更履歴は `get_page` の `pageId` / `commitId` を起点に、1 pageの説明可能な変更だけを返す。Skillはwriteをユーザーの明示指示時だけ許可する方針である。[Skill routing](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/skills/cosense/SKILL.md)

## Cosense read機能の整理

### Pages API v2

`GET /api/pages/v2/shiyui/{encodedTitle}` を本文の唯一の原本取得経路にする。2026-04-11 に、本文と関連ページを分け、関連リストをpagination可能にする目的で導入された。[2026 release notes](https://scrapbox.io/help-jp/%E3%83%AA%E3%83%AA%E3%83%BC%E3%82%B9%E3%83%8E%E3%83%BC%E3%83%882026)

現在確認できる主なfield:

- `title`, `persistent`, `id`（pageId）, `commitId`
- `lines[]`: `id`, `text`, `userId`, `created`, `updated`
- `created`, `updated`, `accessed`, `lastAccessed`
- `pageRank`, `linked`, `views`, `linesCount`, `charsCount`
- `links`, `linksLc`, `projectLinks`, `icons`, `descriptions`
- `files`, `infoboxDefinition`, `infoboxDisableLinks`, `infoboxResult`

`persistent:false` は未作成pageであり、server templateの仮IDを識別子として返してはいけない。現行MCPでは `exists:false` と canonical URLだけを返す。

2026-01-05 に Pages API から userの `name` / `email` が削除された。`get_page` はauthor identityを返さず、Project users APIともjoinしない。users GETは `get_page_changes` のactor名解決だけに限定する。

### Full-text と vector

| 観点         | full-text                                                                          | vector                                         |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| endpoint     | `/api/pages/shiyui/search/query?q=...`                                             | `/api/pages/shiyui/search/vector/titles?q=...` |
| 対象         | page本文                                                                           | page title + 本文中の `[title]` link記法       |
| 通常本文     | 対象                                                                               | 対象外                                         |
| matching     | 既定AND、`op=or`でOR                                                               | semantic similarity                            |
| sort         | `pageRank` / `updated`                                                             | score降順                                      |
| result       | 一致words、lines、exact-title、metadata                                            | `score`、`exists`、metadata                    |
| 現行観測     | responseの `limit` は100で、指定した `limit` / `skip` は無視。hard maximumは未確認 | 20件を返し、`limit` / `skip` は無視            |
| scoreの定義  | 該当なし                                                                           | 距離関数、範囲、thresholdは非公開              |
| index反映SLA | 非公開                                                                             | 非公開                                         |

Vector searchは本文全体の意味検索ではない。`exists:false` は、実pageがなく、他pageのリンク記法にtitleだけが存在する候補である。[official CLI vector contract](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/src/commands/searchVector.ts)

2026-03-24 にtitle vectorが追加され、03-25にはJSON import後のtitle vectorを定期batchで修復、04-13には空pageへのlink記法が対象に追加された。この履歴から非同期処理の存在は分かるが、通常編集の反映時間は分からない。

UIのQuick Searchは、先頭5件のQuick Search、vector、残りのQuick Searchを融合する。raw vector endpointはUIの検索順位そのものではない。MCPは意図が異なるfull-textとvectorを分け、ChatGPTが選択できるようにする。

### Related / 1-hop / 2-hop / Smart Context

| 機能          | 内容                                             | endpoint                                                          | 現行MCP      |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------------- | ------------ |
| 1-hop         | 直接link・backlink関係                           | Page v2 `/links1hop`                                              | PAT付きGET   |
| 2-hop         | 共通HeadWord等を介した関連。直接1-hopは含めない  | Page v2 `/links2hop`                                              | PAT付きGET   |
| hop内検索     | hop集合を `search`、任意で `op=or` により絞る    | 同上 query                                                        | PAT付きGET   |
| relation      | outgoing / incoming / bidirectional              | endpoint fieldではなく、base pageと候補の `linksLc` からCLIが計算 | local計算    |
| Smart Context | 関連する複数page本文を1つのplain-text fileに集約 | `/api/smart-context/export-{1,2}hop-links/...`                    | tool化しない |

hop responseのpaginationは `{perPage,total,hasNext,nextId}`、既定 `perPage=1000` である。次pageは `nextId` と `perPage` をqueryに渡すことを、2026-08-12の公式Web client asset `assets-20260810-073323` で確認した。[official web bundle](https://scrapbox.io/assets/chunks/chunk-BZ7AQD4N.js)

現行の `get_related_pages` は一覧を文脈候補として返し、本文は返さない。上位候補を取得後に `get_page` を使う。起点pageも取得して1-hopのrelationを計算する。大量列挙ではなく選択が目的なので、toolの `limit` は最大20とし、upstreamへ同じ値を `perPage` として渡す。受信した候補にも同じ上限を適用する。`hasNext` がtrueなら `nextId` をopaqueな `nextCursor` として返し、次callの `cursor` で続きから取得する。

Smart Contextは1 requestで大量本文を取れる利点があるが、次の理由で採用しない。

- 大量本文を一度にLLMへ渡しやすい
- hop一覧から必要pageだけ Pages API v2 で読む構成と重複する
- plain-text schema、server hard limit、更新保証が公開されていない

## 2026年の関連release

出典は [Cosense公式リリースノート2026](https://scrapbox.io/help-jp/%E3%83%AA%E3%83%AA%E3%83%BC%E3%82%B9%E3%83%8E%E3%83%BC%E3%83%882026)。公式pageは手動更新の遅延があり、2026-08-12時点の最終掲載は04-13であるため、それ以後に変更がないとは断定しない。

| 日付       | read用途に関係する変更                                             | 含意                                                         |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| 2026-01-05 | Pages APIからuser `name` / `email`を削除                           | `get_page`ではjoinせず、変更履歴のactor名解決だけusersを取得 |
| 2026-02-23 | private Smart Context向けsigned URL                                | private context共有の正式経路。5分・1回利用                  |
| 2026-02-24 | Service Account / Smart Context rate-limit model調整               | rate limitの存在は分かるが数値は非公開                       |
| 2026-03-24 | page title vector search                                           | semanticなtitle候補取得が可能                                |
| 2026-03-25 | JSON import title vectorの定期修復、UIでQuick Searchとvectorを融合 | raw vectorとUI検索は同一でない                               |
| 2026-03-27 | link補完でもQuick Searchとvectorを融合                             | UI固有の候補合成                                             |
| 2026-03-30 | vector API callを共通hook化                                        | 外部契約変更とは断定不可                                     |
| 2026-04-11 | Pages API v2。本文とrelated分離、pagination、2-hop search拡張      | v2本文 + hop endpointを採用                                  |
| 2026-04-12 | 非2-hop-searchのrelatedにも取得上限                                | pagination metadataを無視しない                              |
| 2026-04-13 | 空pageへのlink記法もvector対象                                     | `exists:false`を扱う                                         |

03-08の対話context export/import、03-17のPR review、04-06のsubagent consultation等、AI Agent向けSkillの追加も記録されている。これらはCosense RESTのread endpointではなく、今回のMCP toolとして移植しない。API利用方法とPAT headerは、公式リリースノートだけでなくHelpfeel公式CLIの固定commit `70c6229` と過去の本番実測で補った。

固定commit `70c6229` の公式CLIは Pages v2 と分割hop endpointを使う一方、hopの `pagination.nextId` を処理しない。現行MCPは大量pageを一括取得せず、`perPage=limit` と `nextId` cursorで必要な続きだけ取得できるようにする。

## 最新性、cache、index、rate limit

### 確認できたこと

- Pages v2は `commitId`、page/lineの `updated`、本文を直接返す。
- 同じ Pages v2 requestの無条件反復は毎回 `200` だった。
- 弱い `ETag` があり、同じ値を `If-None-Match` で送ると `304` になった。
- 初回、条件付き、反復のすべてで `CF-Cache-Status: DYNAMIC` だった。
- `Cache-Control`、`Age`、`Last-Modified` はなかった。
- 既存MCPと公式CLIにpage/search response cacheはない。

### 保証できないこと

- 編集から Pages API v2 への最大反映時間
- strong consistency
- full-text / vector / hop indexの更新遅延。writeを行わない今回の調査では、変更時刻を作れず実測していない
- Cosense側cacheのTTL / revalidation契約
- rate limitのrequest数、window、429 body、`Retry-After`

検索結果は候補発見にだけ使い、最終本文は必ず `get_page` で Pages API v2から再取得する。MCPは本文を保存せず、Workers subrequestには `cache: "no-store"` を指定する。[Workers fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/) 今回の実測は `CF-Cache-Status:DYNAMIC` だったが、`scrapbox.io` 自体もCloudflare配下であり、この指定だけでCosense側CDNの将来挙動まで保証しない。CosenseとCloudflareに公開されたcache freshness契約がない点は残る。

MCP responseにも `Cache-Control: no-store` を付け、Cache API、Cache Rules、KVへの本文保存を行わない。

## Cosense側credentialの選択

| 方式                     | 特性                                                     | 保存                     | 判断                        |
| ------------------------ | -------------------------------------------------------- | ------------------------ | --------------------------- |
| PAT                      | 公式CLIがread requestへheaderとして付与                  | Cloudflare Secret        | 採用。全GETで必須           |
| なし                     | 2026-08-12にPublic dataの匿名GETを観測                   | なし                     | 不採用。fallbackしない      |
| Service Account          | project限定のread credential。Business plan限定          | Cloudflare Secret        | 不採用。PATとのfallbackなし |
| `connect.sid`            | browser session相当                                      | Cloudflare Secret        | 不採用                      |
| Smart Context signed URL | private contextの一時download。発行flowとstateが別途必要 | 発行時にcredentialが必要 | 不採用                      |

Public / Privateを同じrequest pathで扱うため、PATを「Privateのときだけ」付ける分岐は置かない。6 toolが行う1 callあたり1–2件のGETすべてに同じ `COSENSE_PAT` を付与する。Service Account、session、匿名へfallbackしない。

PATは `https://scrapbox.io/settings/personal-access-tokens` で発行する。Helpfeel公式CLIはPATを `x-personal-access-token` として送るが、これは現行sourceに基づく実装上の先例であり、PAT APIが正式に文書化された安定契約だとは断定しない。[login guidance](https://github.com/helpfeel/cosense-cli/blob/70c62293e3755a43f87e58e8dc59e9e896afcbcb/skills/cosense/login.md#L6-L17) [request implementation](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/lib/request.ts#L44-L78)

本番は `npx wrangler secret put COSENSE_PAT` でSecret bindingへ保存する。localはGit管理外の `.dev.vars` にだけ実値を置く。`wrangler.jsonc` の平文 `vars`、`.dev.vars.example`、README、Gitへ実値を置かない。

`COSENSE_PAT` が存在しない場合とtrim後に空の場合は、Cosenseへrequestせず設定エラーにする。Cosenseから `401` または `403` が返った場合は、どちらも同じ認証失敗に変換する。client resultとlogへPAT、upstream body、statusごとの推測を含めない。PATの期限、自動更新、事前通知、`401` と `403` の区別は公開仕様として確認できていないため、失敗時はPATを手動で再発行・再登録して確認する。

将来Smart Contextやfile抽出textが必要になっても、現行6-tool構成へ暗黙に追加しない。credential方式とデータ境界を改めて評価する。

## 推奨MCP tool仕様

projectはsource定数 `shiyui` とし、tool引数にproject、URL、credentialを持たせない。6 toolから発生する全GETにはWorker secret `COSENSE_PAT` を `x-personal-access-token` として付与する。MCP endpoint全体をAccess policyで保護し、各toolは `annotations.readOnlyHint: true`、`openWorldHint: true` とする。外部CosenseへGETするため `openWorldHint` はfalseにしない。現行specで `destructiveHint` / `idempotentHint` は `readOnlyHint:false` の場合だけ意味を持つため、read toolでは省略する。

### `get_page`

入力:

```json
{
  "title": "2026-08-11"
}
```

処理: `GET /api/pages/v2/shiyui/{encodedTitle}`。本文の唯一の取得経路。

出力:

```json
{
  "exists": true,
  "title": "2026-08-11",
  "canonicalUrl": "https://scrapbox.io/shiyui/2026-08-11",
  "pageId": "...",
  "commitId": "...",
  "createdAt": "...",
  "updatedAt": "...",
  "pageRank": 0,
  "linked": 0,
  "links": [],
  "text": "..."
}
```

`text` はtitle行を除いたpage本文を改行で連結する。`persistent:false` はtool errorではなく `exists:false` とする。line ID、author、user email、raw response全体、generated Infoboxは返さない。

### `list_pages`

入力:

```json
{
  "sort": "updated",
  "limit": 10,
  "skip": 0
}
```

`sort` は `updated | created | accessed | linked | views | title`、`limit` は1–20、`skip` は0以上の明示的なoffsetとする。処理は `GET /api/pages/shiyui/?sort=&limit=&skip=` の1 requestだけで完結する。公式CLIの `listPages` は同じ一覧GET後にusersを取得するが、MCPはactorを返さないためusers GETを行わない。[official CLI listPages](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/listPages.ts#L132-L153)

出力は `reportedCount`、`skip`、`returned`、`hasNext`、任意の `nextSkip` と、各pageの `pageId`、`title`、短いdescriptions、作成・更新・アクセス時刻、page metrics、canonical URLに限定する。本文、user情報、raw responseは返さない。一覧取得後のdetail GET、N+1、自動pagination、全件走査を行わず、続きはLLMまたはユーザーが `nextSkip` を次callの `skip` に明示したときだけ取得する。

### `get_page_changes`

入力:

```json
{
  "pageId": "...",
  "commitId": "..."
}
```

`pageId` は `get_page` が返す不変ID、任意の `commitId` は同じ出力のfreshness識別子を使う。commitId指定時は `GET /api/commits/shiyui/{pageId}?head={commitId}`、省略時はqueryなしとし、指定commitより後の変更を取得する。title変更後もpageIdで同じpageを追跡できる。公式CLIの `browsePageChanges` も同じ `head` とpageIdを使う。[official CLI browsePageChanges](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/browsePageChanges.ts#L190-L230)

処理は対象pageのcommits GETと、actor名解決に必要な `GET /api/projects/shiyui/users` の2 requestを並列実行する。この2件だけで完結し、`get_page`、関連page、他pageの履歴は取得しない。自動retry、pagination、再帰取得も行わない。

出力は `pageId`、任意の `afterCommitId`、`commitCount`、`totalChanges`、`returned`、`truncated`、任意の `latestCommitId` / `latestTitleChange` と、説明可能な変更eventを返す。eventはtitle、insert、update、delete、actor name、時刻、任意のbefore/afterだけとする。最新50 eventを上限とし、before/afterは各500文字までに切り詰める。email、user ID、line ID、派生metadata、raw commitは返さない。

### `search_full_text`

入力:

```json
{
  "query": "完璧主義",
  "match": "and",
  "sort": "pageRank",
  "limit": 10
}
```

`match` は `and | or`、`sort` は `pageRank | updated`、`limit` は1–20。現行responseは `limit:100` と報告し、指定したlimit/skipを無視したため、MCPは受信候補を最大20件にsliceする。upstreamのhard maximumは未確認である。

出力は `reportedCount`、`exactTitleMatch`、`returned`、`truncated` と、各候補の `title`、一致snippet、matched words、`updatedAt`、`pageRank`、canonical URLに限定する。本文全体は返さない。

### `search_vector`

入力:

```json
{
  "query": "失敗するのが怖くて始められない",
  "limit": 10
}
```

出力は `returned`、`localTruncated` と、各候補の `title`、`score`、`exists`、canonical URL。`updatedAt` と `pageRank` は `exists:true` の候補だけに付くoptional fieldとする。`localTruncated` は受信した配列を指定limitでsliceしたかだけを示し、upstreamの総数や続きが存在するかは表さない。vector endpointの総数・pagination方法は不明である。descriptionには「titleとlink記法のsemantic searchであり、通常本文は対象外」と明記し、`score`の絶対値に独自thresholdを置かない。

### `get_related_pages`

入力:

```json
{
  "title": "日記",
  "hop": 1,
  "query": "2026",
  "match": "and",
  "limit": 10
}
```

`hop` は `1 | 2`。queryと `cursor` は任意、matchは `and | or`、limitは1–20。title、query、cursorは最大500文字。`limit` はupstreamの `perPage` と受信候補のlocal上限に使う。続きがある場合はresponseの `nextCursor` を次callの `cursor` に渡し、Workerはopaque stringとしてupstreamの `nextId` へ転送する。1-hopでは起点pageも取得し、`outgoing | incoming | bidirectional` を計算する。2-hopはrelationを付けない。

出力は候補の `title`、短いdescriptions、relation、`pageRank`、`linked`、`updatedAt`、canonical URL、upstream paginationの `total`、`hasNext`、`nextCursor`。page本文は返さない。

### MCP resultの形

各toolは、人間向けの `title`、機械可読な `outputSchema`、短い `content`、`structuredContent` を返す。巨大なraw JSONや同じ本文の重複は避ける。現在のMCP tool call resultは `resultType: "complete"` を要求する。`tools/list` には `resultType: "complete"`、`ttlMs: 0`、`cacheScope: "private"` を設定し、認証された一人用tool metadataをprotocol上もcacheしない。SDKが実際にこの形を出すことをcontract testで確認する。[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) [OpenAI MCP build guide](https://developers.openai.com/plugins/build/mcp-server)

## 現行MCPへ採用しない機能

| 機能                                   | 理由                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Pages API v1 / Web page scrape         | v2が本文とrelatedを分離。最新本文の原本を一つにする                        |
| Smart Context                          | 大量本文、既存toolと重複、schema/limit非保証                               |
| browse系の巨大context                  | tool内で候補選択と本文取得を混ぜない                                       |
| file metadata / download               | binary/OCR用途は現行MCPの中心でなく、任意file fetchを持たせない            |
| Project users / members tool           | 公開toolにはせず、変更履歴のactor名解決に必要なGETだけを内部利用           |
| Infobox table生成                      | generated resultにhallucination/truncated flagがあり、本文からの参照を優先 |
| page creation / append / edit / delete | read-only要件。write code自体を置かない                                    |
| arbitrary project / arbitrary URL      | 固定projectとSSRF防止に反する                                              |
| 独自embedding / vector DB / index      | Cosenseのvectorを利用する                                                  |
| cache / background sync / cron         | 最新性を損ね、運用対象を増やす                                             |
| D1 / R2 / Queue / MCP用Durable Object  | stateless tool callには不要                                                |

## Cloudflare Workers / MCP / OAuth

### Architecture

```text
ChatGPT
  -> HTTPS Streamable HTTP /mcp
  -> Cloudflare Access Managed OAuth
     -> 許可email 1件 + One-time PIN policy
     -> Cf-Access-Jwt-Assertion
  -> Workerで署名 / issuer / Application Audience / expを検証
  -> createMcpHandler(createServer)
  -> 6 read-only tools
  -> 必須Cloudflare Secret COSENSE_PATを解決
     -> 未設定 / 空: upstreamへ接続せず失敗
  -> fetch(GET, cache: "no-store", x-personal-access-token: COSENSE_PAT)
  -> scrapbox.io の shiyui 固定endpoint
```

Cloudflare Access Managed OAuth、One-time PIN、Access assertion検証は従来どおりMCP clientの認証を担う。`COSENSE_PAT` はWorkerからCosenseへの別の認証境界であり、OAuth tokenやAccess assertionから導出しない。

Cloudflare はgreenfield serverに stateless `createMcpHandler()` を推奨し、`McpAgent` はdeprecated / feature-frozenとしている。[Remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) [Handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)

使用dependency:

- `agents`
- `@modelcontextprotocol/server` v2
- `zod`
- `wrangler`（dev dependency）
- `jose`（Access assertion検証）

直接dependencyは `package.json`、解決した全dependencyは `pnpm-lock.yaml` に固定する。`pnpm-workspace.yaml` の `minimumReleaseAge: 10080` により、直接・間接とも公開後7日未満のversionと公開日時不明のversionを拒否する。公式 `cosense-cli` はNode >=24と`tsx`を前提にしたCLIで、Workersに載せると不要なcommand/file/system処理が増えるためdependencyにはしない。

### MCP protocolとChatGPT

現行MCP revisionは2026-07-28で、stateless POST、`server/discover`、tool result metadata等が以前のrevisionから大きく変わった。[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) 実装ではSDKとCloudflare handlerにprotocol処理を委譲する。

ChatGPT Developer modeは公開HTTPSのStreamable HTTP `/mcp`を登録でき、OAuth、No Authentication、Mixed Authenticationを扱う。今回のtoolはすべてOAuth必須にする。tool metadata変更後はapp settingsでRefreshし、新しいconversationで確認する。[Connect to ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) [Plugin authentication](https://developers.openai.com/plugins/build/auth)

Managed OAuthはAccess edgeをOAuth authorization serverにする。Protected Resource Metadata、authorization server metadata、DCR、PKCE、authorization code、access / refresh token、policy再評価はCloudflareが担当する。WorkerはOAuth endpoint、callback、consent、state、grant、token storageを持たない。[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

### one-user OAuthの選択

採用: Cloudflare Access Managed OAuth

- Access policyで許可emailを1件に限定できる。
- One-time PINを本人確認に使える。
- OAuthのstateとtokenをWorkerで保存しない。
- Worker側のOAuth secretとKVが不要になる。
- 6 toolすべて同じread-only権限なのでcustom scopeを設けない。

Access for SaaSのGeneric OIDC applicationは使用しない。Self-hosted Access applicationでWorkerの公開hostnameを保護し、Managed OAuthとDCRを有効にする。Access policyはIncludeを本人のemail 1件にし、identity providerはOne-time PINだけを利用可能にする。

Preview URLは使用せず、`wrangler.jsonc` とCloudflare上で無効にする。Managed OAuthのlocalhost clientとloopback clientも使用しない。

2026-08-12にCloudflare上でも、全identity providerの自動許可を無効にしてOne-time PINだけを選択し、localhost clientとloopback clientを無効にした。DCRのredirect URIはChatGPT管理画面の正確なcallback URIを確認できるまで `https://chatgpt.com/connector/oauth/*` を維持し、推測した値へ置き換えない。

### Origin assertion

Managed OAuthのclient bearerはopaqueであり、Workerでdecodeしない。Access edgeが認証後に付与する `Cf-Access-Jwt-Assertion` を、team domainのJWKSで検証する。

- JWKS: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
- issuer: `https://<team>.cloudflareaccess.com`
- audience: Access applicationのAudience tag
- algorithm: RS256
- time: `exp`を必須とし、存在する`nbf`も`jose`に検証させる

`TEAM_DOMAIN` と `POLICY_AUD` は非secretのWorker変数である。assertion欠落または検証失敗はWorker入口で403にし、tool handlerへ到達させない。emailの完全一致はAccess policyだけで行う。

## セキュリティ境界

- originは `https://scrapbox.io` 固定。
- projectは `shiyui` 固定。
- tool入力はtitle、query、pageId、commitId、enum、上限付きlimit、非負のoffsetだけ。
- LLMからURL、project、header、credential、file pathを受け取らない。
- allowlist済みpath builder以外をfetchしない。
- HTTP methodはGETだけ。write endpoint文字列、WebSocket dependency、edit operationをsourceに置かない。
- `COSENSE_PAT` はCloudflare SecretまたはGit管理外のlocal `.dev.vars` にだけ保存する。
- `COSENSE_PAT` が未設定または空ならupstream requestを送らず失敗する。
- Public / Privateにかかわらず、全Cosense GETへ `x-personal-access-token` を付与する。
- Service Account、`connect.sid`、匿名requestへfallbackしない。
- Workerの公開hostname全体をAccess applicationで保護する。
- Preview URLは使用せず、`wrangler.jsonc` とCloudflare上で無効にする。
- Worker入口で `Cf-Access-Jwt-Assertion` を検証し、欠落・不正・期限切れは403にする。
- 未認証clientへの401とOAuth discoveryはAccess edgeに委譲する。
- custom scopeとtool内の重複認可は実装しない。
- `Origin` と current MCP mirrored headersの検証はSDK/handlerに委譲する。
- responseをcacheしない。
- logにPAT、page本文、query、OAuth token、Access assertionを出さない。
- upstreamの `401` / `403` は同じ認証失敗として返し、PAT、upstream body、statusごとの推測を含めない。
- その他のupstream errorもbodyをそのままLLMへ返さない。
- email、user ID、line IDをresponseから除外する。変更履歴のactorはnameだけを返す。

## 受け入れテスト

最低限次を確認する。

| 対象             | 確認内容                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| PAT設定          | `COSENSE_PAT` の欠落と空白だけの値でfail closedになり、Cosense fetchを行わない                       |
| PAT送信          | 6 toolの全GETへ `x-personal-access-token` を送り、Public / Privateで分岐しない                       |
| PAT error        | upstreamの `401` / `403` を同じ認証失敗として返し、PATとupstream bodyをresponse / logへ含めない      |
| `get_page`       | `日記`、`2026-08-11`、日本語、space、`/ % ? #`を含むtitle、未作成page                                |
| 最新性           | test page更新直後に本文、`commitId`、`updated`が変わること。保証値にはしない                         |
| full-text        | AND、OR、pageRank、updated、limit slice、empty result                                                |
| vector           | semantic query、score順、`exists:false`、limit slice                                                 |
| related          | 1-hop、2-hop、search、OR、relation、pagination metadata、empty result                                |
| page list        | sort、limit 1–20、skip、nextSkip、empty result。1 callが一覧GET 1件だけで、detail GETを行わない      |
| page changes     | pageId、任意commitId、title/insert/update/delete、actor名、50件上限、500文字切り詰め、empty result   |
| request境界      | changesはcommits/usersの並列2 GETだけ。自動pagination、N+1、retry、他pageへの展開を行わない          |
| response         | raw巨大responseやuser emailを返さない                                                                |
| read-only        | registered toolが6つだけ、GET以外が存在しない                                                        |
| boundary         | arbitrary project、arbitrary URL、file fetchをschema上も実装上も受け付けない                         |
| cache            | upstream subrequestとMCP responseがno-store、Cosense本文を永続化しない                               |
| Access assertion | 欠落、別application audience、期限切れを拒否し、正しいassertionだけtools/listへ到達                  |
| protocol         | MCP Inspectorでdiscovery/list/call、current headers、JSON response、`resultType` / cache hintsを確認 |
| ChatGPT          | Developer modeからOne-time PIN、tool discovery、PAT認証済みのPublic / Private read callを確認        |

2026-08-13に実PATを一時的なprocess環境変数から渡し、当時の4 toolをlocal MCP tool layer経由でPublicの `shiyui` に対して確認した。PATはfile、command引数、log、結果へ保存していない。追加した `list_pages` と `get_page_changes` のlive確認結果ではない。

| call                      | 結果 | returned |
| ------------------------- | ---- | -------: |
| `get_page`                | 成功 |        1 |
| `search_full_text`        | 成功 |        2 |
| `search_vector`           | 成功 |        2 |
| `get_related_pages` 1-hop | 成功 |        3 |
| `get_related_pages` 2-hop | 成功 |        1 |

5 callが発生させた6件のupstream GETすべてで、`x-personal-access-token` が入力されたPATと一致することもruntimeで検証した。これはlocalの実通信確認であり、Cloudflare Access経由、ChatGPT接続、Private projectのtool call成功を示すものではない。

同日にPAT必須版をProductionへdeployし、その後6-tool版もVersion `494a0aed-57bf-4091-9be0-03f58726b843` として100%へ反映した。`COSENSE_PAT` が `secret_text` bindingとして保持されていることと、未認証の `/mcp` requestが `401`、`no-store` で拒否されることを確認した。Secret値の取得・表示は行っていない。

初回deploy前に `npx wrangler secret put COSENSE_PAT` で本番Secretを登録した。各deploy前にformat check、typecheck、test、`wrangler deploy --dry-run` を通し、6-tool版のProduction deploy後もCloudflare Accessの未認証拒否を確認した。次の実利用確認は追加2 toolを含むChatGPTからのread callとし、callback URIはapp管理画面に表示された値をDCR allowlistへ登録する。

## Maintenance risk

| risk                         | 影響                                     | 対応                                                                                     |
| ---------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Cosense内部APIの予告なし変更 | field/path/queryが壊れる                 | 必要なread pathだけに限定、used fieldだけ検証、明確に失敗、公式CLI/releaseを更新時に確認 |
| vector/full-text index遅延   | 検索直後に新pageが出ない                 | 候補選択後は必ずPages v2。SLAを約束しない                                                |
| response上限の変更           | 検索候補が欠落                           | observed valueを仕様化せず、returned/truncatedを返す                                     |
| related pagination変更       | 続きの候補が取れない                     | `perPage=limit`、`hasNext/nextId`をopaque cursorとして往復                               |
| rate limit非公開             | 429や一時失敗                            | 1 call 1–2 request、N+1回避。429を明示し、無制限retryしない                              |
| PAT失効・header仕様変更      | 全toolのCosense GETが失敗                | 401/403を安全な認証失敗へ変換し、公式CLI source確認後に手動再発行・Secret差し替え        |
| PAT漏洩                      | user権限の範囲でCosense dataへアクセス   | Cloudflare Secretだけに保存し、input、response、log、Gitへ出さない                       |
| OAuth / MCPの変更            | ChatGPT接続が壊れる                      | Cloudflare Accessとcurrent SDKへ委譲し、独自互換layerを足さない                          |
| Access設定の誤り             | 意図しない利用者への公開、または接続失敗 | exact email 1件、One-time PINのみ、team domain、Application Audienceを確認               |
| ChatGPT protocol revision差  | discovery/call不成立                     | 実利用で確認し、観測した問題だけを直す                                                   |

## 確定した設計

Cosense側はCloudflare Secret `COSENSE_PAT` を必須とし、Public / Privateを同じPAT付きGETで読む。未設定・空はfail closed、upstreamの `401` / `403` はtokenとbodyを含まない認証失敗にする。toolは上記6つだけで、write、任意project、任意URL、本文cache、credential fallbackを持たない。`list_pages` は一覧GET 1件、`get_page_changes` は対象pageのcommits/users並列2 GETだけとし、自動pagination、N+1、retry、他pageへの展開を行わない。MCP clientの本人確認は従来どおりCloudflare Access Managed OAuth、許可email 1件、One-time PINとする。

## 調査成果物20項目の対応

|     # | 必須項目                      | 主な記載箇所                                      |
| ----: | ----------------------------- | ------------------------------------------------- |
|     1 | 既存MCPのread-only機能        | 「既存 `scrapbox-cosense-mcp`」                   |
|     2 | 公式CLIのread-only機能        | 「Helpfeel公式 `cosense-cli`」                    |
|   3–4 | endpoint、method、parameters  | 過去の匿名実通信表、CLI表、各機能節               |
|   5–7 | 認証、credential、実通信      | 「過去の匿名実通信」「Cosense側credentialの選択」 |
|   8–9 | credential方式と差            | 「Cosense側credentialの選択」                     |
| 10–11 | vector仕様、full-textとの差   | 「Full-text と vector」                           |
|    12 | Pages API v2                  | 「Pages API v2」                                  |
|    13 | related / hop / Smart Context | 同名節                                            |
|    14 | 2026年release                 | 「2026年の関連release」                           |
|    15 | 最新性 / cache / index        | 同名節                                            |
| 16–17 | 採用 / 不採用                 | tool仕様、現行MCPへ採用しない機能                 |
|    18 | credential比較                | credential選択表                                  |
|    19 | 推奨最終構成                  | 結論、Cloudflare architecture                     |
|    20 | maintenance risk              | risk表                                            |
