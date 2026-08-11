# Cosense read-only Remote MCP 調査報告

調査日: 2026-08-12（JST）

状態: 調査完了。v1設計を確定し、アプリケーションコードとfixture testを実装。Cloudflare Access設定とデプロイは未実施。

## 結論

`shiyui` の通常の参照用途には、Cosense 側の secret は不要である。2026-08-12 の匿名実通信で、次の機能から実データを取得できた。

- Pages API v2 による現在のページ本文
- 全文検索
- Cosense 自身のタイトル・リンク記法ベクトル検索
- 1-hop / 2-hop の関連ページ取得と絞り込み

一方、Smart Context、ページ変更履歴、アップロードファイルのメタデータは匿名では `401` だった。これらのためだけに PAT、Service Account、または `connect.sid` を持つ価値は、初期版にはない。Smart Context は大量の本文を一度に返すが、検索・関連ページ取得後に必要なページだけ Pages API v2 で読む方が、ChatGPT の文脈量、最新性、secret の運用負荷の面で適している。

推奨する v1 は、次の4 toolに限定する。

1. `get_page`
2. `search_full_text`
3. `search_vector`
4. `get_related_pages`

Cosense 側は完全に secretless とし、MCP endpoint 自体は OAuth で一人だけに制限する。Cloudflare Workers では、現行の stateless `createMcpHandler()`、`@modelcontextprotocol/server` v2、`@cloudflare/workers-oauth-provider`、OAuth 専用の `OAUTH_KV` を使う。MCP session、Durable Objects、D1、R2、独自 cache、同期 job は不要である。

OAuth の本人確認はCloudflare Access for SaaSとし、許可email 1件 + One-time PIN policyを使う。Worker callbackでも同じemailを完全一致で検証する。

## 調査範囲と根拠

ソースの README だけでなく、command 登録、HTTP 実装、認証解決、レスポンス加工、テスト、公式 Help、公式 Web client、実通信まで確認した。

| 対象                                                                                                                                | 固定した版                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`worldnine/scrapbox-cosense-mcp`](https://github.com/worldnine/scrapbox-cosense-mcp/tree/d4f649f3c18383d748cbda73b9181c59c0f2d8ce) | `d4f649f3c18383d748cbda73b9181c59c0f2d8ce`（v0.9.0 系）                |
| [`helpfeel/cosense-cli`](https://github.com/helpfeel/cosense-cli/tree/e06bc890958cfe8d1b6fe932db06c35eb8c8577d)                     | `e06bc890958cfe8d1b6fe932db06c35eb8c8577d`（v1.10.1）                  |
| Cosense 公式 Help / 本番 API / Web client                                                                                           | 2026-08-12 に確認                                                      |
| MCP specification                                                                                                                   | [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) |
| Cloudflare Agents / OAuth Provider                                                                                                  | 2026-08-12 の公式 documentation と current example                     |
| OpenAI ChatGPT Developer mode / plugin documentation                                                                                | 2026-08-12 に確認                                                      |

Cosense は公式に、掲載 API を内部 API とし、予告なく変更する可能性があると明記している。そのため本報告では、次の3種類を区別する。

- 公式 Help に記述された仕様
- Helpfeel 公式 CLI / Web client が現在使用する実装
- 2026-08-12 の本番環境での観測値

安定した公開 API 契約として扱わない。[Cosense API Help](https://scrapbox.io/help-jp/API)

実装環境はmacOS 26.5.2 arm64、Node.js 24.15.0、npm 11.12.1、pnpm 11.16.0、Homebrew 6.0.12、Git 2.50.1を確認した。Wranglerはglobal未導入なので、repositoryのdev dependencyとしてversion固定して使う。

## 匿名実通信の結果

`curl -q` を使い、Cookie、`connect.sid`、Authorization、PAT、Service Account key、curl 設定を付けずに `https://scrapbox.io/shiyui/` のデータを取得した。レスポンス本文は保存していない。

| 機能                | GET endpoint                                                 | status | 取得結果                                           | Cosense secret |     v1 |
| ------------------- | ------------------------------------------------------------ | -----: | -------------------------------------------------- | -------------: | -----: |
| ページ一覧          | `/api/pages/shiyui/?limit=10&skip=0&sort=linked`             |    200 | 件数、page metadata、10件の実ページ                |           不要 | 不採用 |
| Pages API v2        | `/api/pages/v2/shiyui/日記`                                  |    200 | `commitId`、12行の本文、links、files、page metrics |           不要 |   採用 |
| Pages API v1        | `/api/pages/shiyui/日記`                                     |    200 | 本文と旧 `relatedPages` shape                      |           不要 | 不採用 |
| 全文検索            | `/api/pages/shiyui/search/query?q=日記`                      |    200 | 11件、exact title、一致行、Elasticsearch metadata  |           不要 |   採用 |
| vector              | `/api/pages/shiyui/search/vector/titles?q=日記`              |    200 | 3件、`score`、`exists`                             |           不要 |   採用 |
| 1-hop               | `/api/pages/v2/shiyui/日記/links1hop`                        |    200 | 12件、pagination                                   |           不要 |   採用 |
| 2-hop               | `/api/pages/v2/shiyui/日記/links2hop`                        |    200 | 1件、pagination                                    |           不要 |   採用 |
| 1-hop search        | `.../links1hop?search=2026`                                  |    200 | 絞り込み6件、match metadata                        |           不要 |   採用 |
| 2-hop search        | `.../links2hop?search=2026`                                  |    200 | 正常応答、該当0件                                  |           不要 |   採用 |
| Project users       | `/api/projects/shiyui/users`                                 |    200 | 公開 user map                                      |           不要 | 不採用 |
| Smart Context 1-hop | `/api/smart-context/export-1hop-links/shiyui.txt?title=日記` |    401 | `NotLoggedInError`                                 |           必要 | 不採用 |
| Smart Context 2-hop | `/api/smart-context/export-2hop-links/shiyui.txt?title=日記` |    401 | `NotLoggedInError`                                 |           必要 | 不採用 |
| ページ変更履歴      | `/api/commits/shiyui/{pageId}`                               |    401 | `NotLoggedInError`                                 |           必要 | 不採用 |
| file metadata       | `/api/gcs/{public-page-file-id}/info`                        |    401 | `NotLoggedInError`                                 |           必要 | 不採用 |
| public file本体     | `/files/{public-page-file-id}.jpg`                           |    200 | `image/jpeg`、179,637 bytes。bodyは保存せず破棄    |           不要 | 不採用 |

匿名で読める各レスポンスに、今回の tool に必要な本文、候補 title、score、match 行、関連 page metadata が含まれていた。今回使用できるCosense credentialはなく、認証成功側の実通信は行っていない。表の401は「匿名不可」を実証したものであり、どのcredentialで成功するかは公式Helpと公式CLI sourceによる分類である。認証の有無による検索品質や取得上限の差を示す公式資料・実測結果はない。

## 既存 `scrapbox-cosense-mcp`

現行 source は9 toolを持つ。[tool registration](https://github.com/worldnine/scrapbox-cosense-mcp/blob/d4f649f3c18383d748cbda73b9181c59c0f2d8ce/src/index.ts#L160-L398)

| tool                | 種別  | endpoint / 処理                               |                    SIDなし |
| ------------------- | ----- | --------------------------------------------- | -------------------------: |
| `get_page`          | read  | `GET /api/pages/{project}/{title}`            |              public を想定 |
| `list_pages`        | read  | list GET 後、各 page を detail GETする N+1    |              public を想定 |
| `search_pages`      | read  | `GET /api/pages/{project}/search/query?q=...` |              public を想定 |
| `get_smart_context` | read  | `GET /api/smart-context/export-{1             | 2}hop-links/{project}.txt` | 不可 |
| `get_page_url`      | local | URL生成のみ                                   |                         可 |
| `create_page`       | write | WebSocket patch。URL-only modeもある          |                writeは不可 |
| `insert_lines`      | write | WebSocket patch                               |                       不可 |
| `edit_lines`        | write | WebSocket patch                               |                       不可 |
| `delete_page`       | write | opt-in登録後、全行削除 patch                  |                       不可 |

GET 系は `COSENSE_SID` が存在するときだけ `Cookie: connect.sid=...` を付け、未設定なら Cookie header 自体を送らない。[page/list/search implementation](https://github.com/worldnine/scrapbox-cosense-mcp/blob/d4f649f3c18383d748cbda73b9181c59c0f2d8ce/src/cosense.ts#L97-L156) [Smart Context](https://github.com/worldnine/scrapbox-cosense-mcp/blob/d4f649f3c18383d748cbda73b9181c59c0f2d8ce/src/cosense.ts#L457-L490)

読み取り結果は Markdown 風 text に加工される。`get_page` は本文、links、作成・更新 metadata、creator/editor 等を連結し、list/search は description や match snippet を整形する。Smart Context の `compact` は `<PageList>` 部分だけを抽出する。

アプリケーションの page/search cache はない。起動時に最大100 pageの resource snapshotを一度作るが、resource readとtool callは再取得する。`list_pages` は一覧に加えて N detail request を実行するため、本用途には重い。

MCP transport は stdio のみであり、Cloudflare Remote MCPへそのまま載せられない。[stdio transport](https://github.com/worldnine/scrapbox-cosense-mcp/blob/d4f649f3c18383d748cbda73b9181c59c0f2d8ce/src/index.ts#L401-L410) 書き込み実装、古い SDK、N+1、source と docs の差異も抱えるため、forkせず、公開 GET が SID なしで成立するという先例だけを採用する。

## Helpfeel 公式 `cosense-cli`

CLIは19 commandを登録している。[command registry](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/cli.ts#L108-L191)

### Read / auth関連 command

read-only commandのHTTP requestはGETである。多くの command は本体 GET と別に `/api/projects/{project}/users` を取得し、user ID と timestamp を人間向けに補完する。この補完 request が失敗すると本体も失敗する。今回のMCPでは user名を必要としないため、この追加 request は採用しない。

表の「project credential」はCLIがPAT / Service Accountを解決して送れるという意味で、必須とは限らない。credentialが見つからなければheaderなしでrequestし、public projectは匿名で成功しうる。`whoami` と `listProjects` だけはorigin PATを明示的に要求する。

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

主要 source: [readPage](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/readPage.ts#L89-L147)、[listPages](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/listPages.ts#L141-L164)、[searchFullText](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/searchFullText.ts#L117-L135)、[searchVector](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/searchVector.ts#L68-L85)、[related helper](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/lib/relatedPages.ts#L5-L16)。

### 非read command

- `login`: `~/.cosense/settings.json` に PAT / Service Account key を保存するローカル認証操作。
- `previewEdit`: `/api/pages/v2/{project}/page-edit-for-ai/preview` へ POSTし、5分のserver-side preview stateを作る。
- `submitEdit`: `/api/pages/v2/{project}/page-edit-for-ai/submit` へ POSTし、pageをcommitする。

これらの code と dependency はv1に含めない。

### CLIの認証・request処理

`requestJson` は credential がある場合だけ、次のいずれかを送る。[request implementation](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/lib/request.ts#L41-L83)

- PAT: `x-personal-access-token`
- Service Account: `x-service-account-access-key`

project command の優先順は `COSENSE_PAT`、matching project Service Account、origin PAT、匿名である。[settings resolution](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/lib/settings.ts#L249-L292) Cookie、retry、timeout、HTTP cache、page/search cache、自動paginationはない。

CLIは source-levelの型を期待するが、runtime response schemaを検証しない。このMCPでは、使用fieldだけを小さく検証し、API shapeが変わったら明確な upstream error にする。

### AI Agent向けSkillから得られる設計知見

公式Skillは、themeを探す際にvector queryを複数の言い換えで試し、候補を選んでからpage本文を読み、必要な場合だけ1/2-hopへ深める手順を勧めている。vectorはtitleとlink記法だけなので、本文語を探す場合はfull-textを使い分ける。すべての関連pageを読むのではなく、description、relation、pageRankから選ぶ。[read-page workflow](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/skills/cosense/read-page.md#L12-L122)

通常の閲覧はAI向けに整形する `browsePage`、edit anchorや機械処理が必要な場合だけraw寄りの `readPage` という境界も明記されている。今回のMCPはwriteを持たないため、`get_page` は本文とfreshness識別子だけを返し、line IDを返さない。404や空pageでrenameが疑われる場合にpageId/commitIdからchangesを辿るworkflowもあるが、change endpointが匿名401のためv1には含めない。Skillはwriteをユーザーの明示指示時だけ許可し、loginをagent自身で実行しない方針である。[Skill routing](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/skills/cosense/SKILL.md#L19-L101)

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

`persistent:false` は未作成pageであり、server templateの仮IDを識別子として返してはいけない。v1では `exists:false` と canonical URLだけを返す。

2026-01-05 に Pages API から userの `name` / `email` が削除された。今回の用途では author identity を返さず、Project users APIとのjoinもしない。これによりrequest数と個人情報を減らす。

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

Vector searchは本文全体の意味検索ではない。`exists:false` は、実pageがなく、他pageのリンク記法にtitleだけが存在する候補である。[official CLI vector contract](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/searchVector.ts#L7-L58)

2026-03-24 にtitle vectorが追加され、03-25にはJSON import後のtitle vectorを定期batchで修復、04-13には空pageへのlink記法が対象に追加された。この履歴から非同期処理の存在は分かるが、通常編集の反映時間は分からない。

UIのQuick Searchは、先頭5件のQuick Search、vector、残りのQuick Searchを融合する。raw vector endpointはUIの検索順位そのものではない。MCPは意図が異なるfull-textとvectorを分け、ChatGPTが選択できるようにする。

### Related / 1-hop / 2-hop / Smart Context

| 機能          | 内容                                             | endpoint                                                          |             匿名 |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------------- | ---------------: |
| 1-hop         | 直接link・backlink関係                           | Page v2 `/links1hop`                                              |               可 |
| 2-hop         | 共通HeadWord等を介した関連。直接1-hopは含めない  | Page v2 `/links2hop`                                              |               可 |
| hop内検索     | hop集合を `search`、任意で `op=or` により絞る    | 同上 query                                                        |               可 |
| relation      | outgoing / incoming / bidirectional              | endpoint fieldではなく、base pageと候補の `linksLc` からCLIが計算 |               可 |
| Smart Context | 関連する複数page本文を1つのplain-text fileに集約 | `/api/smart-context/export-{1                                     | 2}hop-links/...` | 不可 |

hop responseのpaginationは `{perPage,total,hasNext,nextId}`、既定 `perPage=1000` である。次pageは `nextId` と `perPage` をqueryに渡すことを、2026-08-12の公式Web client asset `assets-20260810-073323` で確認した。[official web bundle](https://scrapbox.io/assets/chunks/chunk-BZ7AQD4N.js)

v1の `get_related_pages` は一覧を文脈候補として返し、本文は返さない。上位候補を取得後に `get_page` を使う。起点pageも取得して1-hopのrelationを計算する。大量列挙ではなく選択が目的なので、toolの `limit` は最大20とし、upstreamへ同じ値を `perPage` として渡す。`hasNext` がtrueなら `nextId` をopaque cursorとして返し、次callの `cursor` で続きから取得する。これにより21–1000件目をlocal sliceで飛ばさない。

Smart Contextは1 requestで大量本文を取れる利点があるが、次の理由で採用しない。

- public projectでも認証が必要
- PAT / Service Account / sessionの保守が増える
- 大量本文を一度にLLMへ渡しやすい
- hop一覧から必要pageだけ Pages API v2 で読む構成と重複する
- plain-text schema、server hard limit、更新保証が公開されていない

## 2026年の関連release

出典は [Cosense公式リリースノート2026](https://scrapbox.io/help-jp/%E3%83%AA%E3%83%AA%E3%83%BC%E3%82%B9%E3%83%8E%E3%83%BC%E3%83%882026)。公式pageは手動更新の遅延があり、2026-08-12時点の最終掲載は04-13であるため、それ以後に変更がないとは断定しない。

| 日付       | read用途に関係する変更                                             | 含意                                            |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| 2026-01-05 | Pages APIからuser `name` / `email`を削除                           | user詳細はProject APIとのjoinが必要。v1では不要 |
| 2026-02-23 | private Smart Context向けsigned URL                                | private context共有の正式経路。5分・1回利用     |
| 2026-02-24 | Service Account / Smart Context rate-limit model調整               | rate limitの存在は分かるが数値は非公開          |
| 2026-03-24 | page title vector search                                           | semanticなtitle候補取得が可能                   |
| 2026-03-25 | JSON import title vectorの定期修復、UIでQuick Searchとvectorを融合 | raw vectorとUI検索は同一でない                  |
| 2026-03-27 | link補完でもQuick Searchとvectorを融合                             | UI固有の候補合成                                |
| 2026-03-30 | vector API callを共通hook化                                        | 外部契約変更とは断定不可                        |
| 2026-04-11 | Pages API v2。本文とrelated分離、pagination、2-hop search拡張      | v2本文 + hop endpointを採用                     |
| 2026-04-12 | 非2-hop-searchのrelatedにも取得上限                                | pagination metadataを無視しない                 |
| 2026-04-13 | 空pageへのlink記法もvector対象                                     | `exists:false`を扱う                            |

03-08の対話context export/import、03-17のPR review、04-06のsubagent consultation等、AI Agent向けSkillの追加も記録されている。これらはCosense RESTのread endpointではなく、今回のMCP toolとして移植しない。公式 `cosense-cli` は07-23時点でv1.10.1だが、公式リリースノートの最終掲載より新しいため、API利用方法の現行性はCLI sourceと本番実測で補った。

公式 CLI v1.10.1 は Pages v2 と分割hop endpointを使う一方、hopの `pagination.nextId` を処理しない。v1 MCPは大量pageを一括取得せず、`perPage=limit` と `nextId` cursorで必要な続きだけ取得できるようにする。

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

MCP responseにも `Cache-Control: no-store` を付け、Cache API、Cache Rules、KVへの本文保存を行わない。OAuth Providerが保存するtoken stateは本文cacheとは別物である。

## Cosense側secretの比較

| 方式                     | 可能になること                                              | 保存               | 期限・更新                                                                       | 保守 / risk                                        | 判断     |
| ------------------------ | ----------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------- | -------- |
| なし                     | public page、list、full-text、vector、1/2-hop、users        | なし               | なし                                                                             | 最小                                               | 採用     |
| PAT                      | privateを含むuser権限のGET、CLIが対応するauth-required read | Workers secret     | 公式資料で有効期限・自動更新SLAを確認できず。失効時は401/403になる想定で手動交換 | user権限が広く、漏洩影響が大きい                   | v1不採用 |
| Service Account          | 対象project限定read、全文、page list、Smart Context         | Workers secret     | 自動refreshの公式記述なし。管理画面でkeyを手動発行・失効・交換                   | project限定でPATより安全。Business plan限定        | v1不採用 |
| `connect.sid`            | 既存MCPのprivate GET、Smart Context、WebSocket write        | Workers secret     | session寿命は非公開。再loginとcookie再取得が必要になりうる                       | browser session相当。decoded値をpassword同様に扱う | 不採用   |
| Smart Context signed URL | private contextの一時download                               | 発行時にauthが必要 | 5分、1回                                                                         | URL発行flowとstateが増える                         | 不採用   |

公式 Service Account はBusiness plan限定、project限定のread credentialである。[Service Account](https://scrapbox.io/help-jp/Service_Account) 認証を追加してもwrite codeは不要だが、今回必要な4機能はすでに匿名で使える。認証による検索品質向上、上限緩和、freshness向上を示す根拠もない。

auth-required readの成功根拠は次の強さに留まる。

| 機能                        | 成功根拠                                                       | 認証あり実通信 |
| --------------------------- | -------------------------------------------------------------- | -------------: |
| private page/list/full-text | 公式Service Account Helpと公式CLI                              |         未実施 |
| Smart Context               | Service Account Helpがdownload可能と明記。既存MCPはSID必須実装 |         未実施 |
| page commits                | 公式CLIがPAT/SA対応requestを実装                               |         未実施 |
| `/api/gcs/{id}/info`        | 公式CLIがPAT/SA対応requestを実装                               |         未実施 |

したがって「認証すると成功」は今回のlive confirmationではなく、公式実装上の期待である。実装しない機能についてcredentialを取得してまでpositive testは行わない。

取得・更新経路は次の通りである。

- PAT: `https://scrapbox.io/settings/personal-access-tokens` で発行し、公式CLIは対話的に貼り付けて保存する。自動refresh処理はない。[CLI login flow](https://github.com/helpfeel/cosense-cli/blob/e06bc890958cfe8d1b6fe932db06c35eb8c8577d/src/commands/login.ts#L108-L184)
- Service Account: Project SettingsのService Accounts tabで登録し、表示されたAccess Keyを取得する。自動refreshではなく、管理画面での発行・失効・交換になる。[Service Account設定](https://scrapbox.io/help-jp/Service_Account)
- `connect.sid`: login済みbrowserのsession Cookieを手動取得し、URL decodeした `s:` から始まる値を使う。既存MCP自身もpassword同様に扱うよう警告する。[existing MCP authentication](https://github.com/worldnine/scrapbox-cosense-mcp/blob/d4f649f3c18383d748cbda73b9181c59c0f2d8ce/docs/authentication.md#L3-L31)

PAT / Service Accountを導入する場合は `wrangler secret put` でsecret bindingに保存し、`wrangler.jsonc` の平文 `vars` やGitへ置かない。無効・失効時はupstreamの401/403を安全なcredential errorへ変換し、手動で再発行・再登録する。期限や事前通知が公式に記述されていないため、自動rotationを仮定しない。

将来Smart Contextやfile抽出textが明確に必要になった場合は、`connect.sid` ではなくproject限定Service Accountを先に評価する。導入時は Cloudflare secret に保存し、401/403を明確なcredential失効として返し、rotation手順をREADMEに追加する。

## 推奨MCP tool仕様

projectはsource定数 `shiyui` とし、tool引数にprojectやURLを持たせない。MCP endpoint全体でOAuth `cosense:read` scopeを要求し、各toolは `annotations.readOnlyHint: true`、`openWorldHint: true` とする。外部CosenseへGETするため `openWorldHint` はfalseにしない。現行specで `destructiveHint` / `idempotentHint` は `readOnlyHint:false` の場合だけ意味を持つため、read toolでは省略する。

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

`hop` は `1 | 2`。queryと `cursor` は任意、matchは `and | or`、limitは1–20。`limit` はupstreamの `perPage` に渡し、cursorは直前のresponseの `nextId` だけを受け付ける。1-hopでは起点pageも取得し、`outgoing | incoming | bidirectional` を計算する。2-hopはrelationを付けない。

出力は候補の `title`、短いdescriptions、relation、`pageRank`、`linked`、`updatedAt`、canonical URL、upstream paginationの `total`、`hasNext`、`nextCursor`。page本文は返さない。

### MCP resultの形

各toolは、人間向けの `title`、機械可読な `outputSchema`、短い `content`、`structuredContent` を返す。巨大なraw JSONや同じ本文の重複は避ける。現在のMCP tool call resultは `resultType: "complete"` を要求する。`tools/list` には `resultType: "complete"`、`ttlMs: 0`、`cacheScope: "private"` を設定し、認証された一人用tool metadataをprotocol上もcacheしない。SDKが実際にこの形を出すことをcontract testで確認する。[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) [OpenAI MCP build guide](https://developers.openai.com/plugins/build/mcp-server)

## v1へ採用しない機能

| 機能                                   | 理由                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_pages`                           | discoveryは2種類のsearchとrelatedで足りる。全page列挙をLLMへ渡さない                                                                                                                                                                                         |
| Pages API v1 / Web page scrape         | v2が本文とrelatedを分離。最新本文の原本を一つにする                                                                                                                                                                                                          |
| Smart Context                          | auth必須、大量本文、4-tool構成と重複、schema/limit非保証                                                                                                                                                                                                     |
| browse系の巨大context                  | tool内で候補選択と本文取得を混ぜない                                                                                                                                                                                                                         |
| change history                         | auth必須。現在の内容を読む目的外                                                                                                                                                                                                                             |
| file metadata / download               | `/api/gcs/{id}/info` は匿名401。public projectの実file `/files/{id}` は[公式Help](https://scrapbox.io/help-jp/%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB%E3%82%A2%E3%83%83%E3%83%97%E3%83%AD%E3%83%BC%E3%83%89)どおり匿名200を実測。binary/OCR用途はv1の中心でない |
| Project users / members                | ChatGPTの検索・本文理解に不要。個人情報とrequestが増える                                                                                                                                                                                                     |
| Infobox table生成                      | generated resultにhallucination/truncated flagがあり、本文からの参照を優先                                                                                                                                                                                   |
| page creation / append / edit / delete | read-only要件。write code自体を置かない                                                                                                                                                                                                                      |
| arbitrary project / arbitrary URL      | 固定scopeとSSRF防止に反する                                                                                                                                                                                                                                  |
| 独自embedding / vector DB / index      | Cosenseのvectorを利用する                                                                                                                                                                                                                                    |
| cache / background sync / cron         | 最新性を損ね、運用対象を増やす                                                                                                                                                                                                                               |
| D1 / R2 / Queue / MCP用Durable Object  | stateless tool callには不要                                                                                                                                                                                                                                  |

## Cloudflare Workers / MCP / OAuth

### 推奨architecture

```text
ChatGPT
  -> HTTPS Streamable HTTP /mcp
  -> @cloudflare/workers-oauth-provider
     -> Cloudflare Accessで本人確認・一人だけ許可
     -> OAUTH_KV（OAuth state/identity/code/token/grant/client metadataのみ。Cosense dataなし）
  -> createMcpHandler(createServer)
  -> 4 read-only tools
  -> fetch(cache: "no-store")
  -> scrapbox.io の shiyui 固定GET endpoint
```

Cloudflare はgreenfield serverに stateless `createMcpHandler()` を推奨し、`McpAgent` はdeprecated / feature-frozenとしている。[Remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) [Handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)

使用dependency:

- `agents`
- `@modelcontextprotocol/server` v2
- `@cloudflare/workers-oauth-provider`
- `zod`
- `wrangler`（dev dependency）
- `jose`

直接dependencyは `package.json`、解決した全dependencyは `pnpm-lock.yaml` に固定する。`pnpm-workspace.yaml` の `minimumReleaseAge: 10080` により、直接・間接とも公開後7日未満のversionと公開日時不明のversionを拒否する。公式 `cosense-cli` はNode >=24と`tsx`を前提にしたCLIで、Workersに載せると不要なcommand/file/system処理が増えるためdependencyにはしない。

### MCP protocolとChatGPT

現行MCP revisionは2026-07-28で、stateless POST、`server/discover`、tool result metadata等が以前のrevisionから大きく変わった。[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) 実装ではSDKとCloudflare handlerにprotocol処理を委譲する。

ChatGPT Developer modeは公開HTTPSのStreamable HTTP `/mcp`を登録でき、OAuth、No Authentication、Mixed Authenticationを扱う。今回のtoolはすべてOAuth必須にする。tool metadata変更後はapp settingsでRefreshし、新しいconversationで確認する。[Connect to ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) [Plugin authentication](https://developers.openai.com/plugins/build/auth)

ChatGPTはCIMD、PKCE S256、DCR、pre-registered clientを扱い、現行はCIMDを優先する。MCP serverはProtected Resource Metadata、authorization server metadata、audience/resource、issuer、expiryを検証する。`resourceMetadata.resource` はcanonicalな `/mcp` URL、`authorization_servers` は同じWorkerのissuer URLにexact設定する。bearer validationとtoken stateは `workers-oauth-provider` に委譲するが、operation-level scopeとresource ownershipは自動強制されない。Workerは発行時のscopeを `cosense:read` だけに固定し、各toolでOAuth providerの暗号化propsと、利用可能な場合は標準 `AuthInfo.scopes` を検査する。独自token serverは実装しない。

OpenAIのtool-level OAuth linking UIは各toolの `securitySchemes` も要求するが、MCP 2026-07-28 core `Tool` schemaにこのfieldはなく、現行 `@modelcontextprotocol/server` v2の高水準 `registerTool()` はtop-level extensionを保持しない。このecosystem gapを「SDKへ委譲済み」と扱わない。v1はまずendpoint全体をOAuthで保護し、実装時に次をcontract testする。[MCP Tool schema](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) [OpenAI authentication](https://developers.openai.com/plugins/build/auth)

- 実際の `tools/list` frameに、ChatGPTが必要とする `securitySchemes: [{"type":"oauth2","scopes":["cosense:read"]}]` が残るか。
- 高水準SDKで残らない場合、currentな公式adapterがあるか。
- 公式adapterがない場合、低水準 `tools/list` handlerでこのextensionだけを追加する最小実装に留める。
- server-wide OAuthだけでChatGPTの接続UIが成立する場合、不要な独自adapterを追加しない。

### one-user OAuthの選択

採用: Cloudflare Access

- Access policyで許可emailを1件に限定できる。
- 本人判定をWorker codeのusername比較に置かない。
- `ACCESS_CLIENT_ID`、`ACCESS_CLIENT_SECRET`、authorization/token/JWKS URL、`COOKIE_ENCRYPTION_KEY` が必要。
- 設定項目は多いが、identity policyの責務が明確で、長期保守に向く。

AccessはMCPのOAuth serverそのものではなく、Workerの `/authorize` が使うupstream IdPである。Workerは最初に `parseAuthRequest` でMCP client、redirect URI、resource、scopeを検証し、現行MCP profileに合わせてredirect URIをHTTPSまたはloopbackに限定し、PKCE S256を必須にする。Access-for-SaaSへredirectし、専用 `/callback` でcodeをexchangeし、JWKSを使ってissuer、audience、expiry、issued-at、authorized party、nonce、state / CSRFを検証する。その後、一人用policyで確認したidentityと検証済みclient / scopeを表示する明示的な同意画面を挟み、同意POST自体もCSRF保護してから `completeAuthorization` を呼ぶ。これは一人用でもconfused-deputy対策として省略しない。ChatGPTがMCP OAuthへ戻るcallbackと、AccessからWorkerへ戻るupstream callbackは別URLである。

Access policyだけを変更しても、すでに `OAUTH_KV` に発行済みのMCP grant / refresh tokenは即時失効しない。実装は各requestとtoken更新時に現在の `ALLOWED_EMAIL` を再検査する。全grantを失効する場合は、新しい空のKV namespaceへbindingを切り替える。

CloudflareのOAuth quick-deploy exampleには旧 `McpAgent` が残るものがある。認証handlerの考え方だけを使い、transportはcurrent stateless exampleを基準にする。[Cloudflare authorization options](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/) [Access guide](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)

### OAuth stateとbinding

必要なstateful componentは `OAUTH_KV` 1個だけである。OAuth Providerはauthorization code、PKCE challenge、access/refresh token、grant、client情報を保存する。標準TTLはcode 10分、access token 1時間、refresh token 30日、DCR client 90日。token等はhash化され、`props` は暗号化されるが、record key、user ID、一般metadataまで暗号化されるとは扱わない。code exchange後のgrantはtoken TTLとは別に残りうる。[workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) [storage schema](https://github.com/cloudflare/workers-oauth-provider/blob/main/storage-schema.md)

OAuth Providerは `clientIdMetadataDocumentEnabled: true`、`allowPlainPKCE: false`、`allowImplicitFlow: false` を明示する。`wrangler.jsonc` には少なくとも次が必要になる。

- `nodejs_compat`
- `global_fetch_strictly_public`（CIMD fetchのSSRF対策とadvertisingに必要）
- `OAUTH_KV` binding

CIMD supportの広告には `clientIdMetadataDocumentEnabled: true` と `global_fetch_strictly_public` の両方を満たす。implementation時点のcurrent `compatibility_date` を設定し、古いdate向けのcache compatibility fallbackは追加しない。

Cosense dataをKVへ入れない。KVはeventual consistencyで地域間反映に60秒以上かかる場合があり、初回OAuth直後のtoken認識遅延はmaintenance riskとして受け入れる。[Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

DCRは現行MCPでdeprecatedであり、ChatGPT専用ならCIMDだけでよい。`createMcpHandler` は `legacy: "reject"` を明示し、current protocolだけを受け付ける。古いclient互換は要求されていないため、live ChatGPT testで不成立でもcustom legacy layerを黙って追加せず、観測したrevision差を報告して設計を再判断する。

## セキュリティ境界

- originは `https://scrapbox.io` 固定。
- projectは `shiyui` 固定。
- tool入力はtitle、query、enum、small integerだけ。
- LLMからURL、project、header、credential、file pathを受け取らない。
- allowlist済みpath builder以外をfetchしない。
- HTTP methodはGETだけ。write endpoint文字列、WebSocket dependency、edit operationをsourceに置かない。
- `/mcp` 全体をOAuth `cosense:read` で保護し、handlerでOAuth propsと利用可能な `AuthInfo.scopes` を明示検査する。tool-level `securitySchemes` は前述のwire contractを満たす場合だけ宣言する。
- invalid/expired tokenは401、insufficient scopeは403。
- 認証challengeはOAuth Providerの `WWW-Authenticate` を使う。tool resultの `_meta["mcp/www_authenticate"]` はChatGPT実機で必要と確認した場合だけ追加する。
- `Origin` と current MCP mirrored headersの検証はSDK/handlerに委譲する。
- response、OAuth error、authorize callbackをcacheしない。
- logにpage本文、query、token、OAuth code、cookieを出さない。
- upstream error bodyはそのままLLMへ返さず、statusと安全なcontextだけを返す。
- responseのuser name/emailは不要なので除外する。

## 実装フェーズの受け入れテスト

調査後に実装へ進む場合、最低限次を確認する。

| 対象             | 確認内容                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_page`       | `日記`、`2026-08-11`、日本語、space、`/ % ? #`を含むtitle、未作成page                                                                                                                                                               |
| 最新性           | test page更新直後に本文、`commitId`、`updated`が変わること。保証値にはしない                                                                                                                                                        |
| full-text        | AND、OR、pageRank、updated、limit slice、empty result                                                                                                                                                                               |
| vector           | semantic query、score順、`exists:false`、limit slice                                                                                                                                                                                |
| related          | 1-hop、2-hop、search、OR、relation、pagination metadata、empty result                                                                                                                                                               |
| response         | raw巨大responseやuser emailを返さない                                                                                                                                                                                               |
| read-only        | registered toolが4つだけ、GET以外が存在しない                                                                                                                                                                                       |
| scope            | arbitrary project、arbitrary URL、file fetchをschema上も実装上も受け付けない                                                                                                                                                        |
| cache            | upstream subrequestがno-store、MCP responseもno-store、KVにCosense dataなし                                                                                                                                                         |
| OAuth            | metadata discovery、PKCE、client/redirect/resource/scope検証、同意画面とCSRF、Access callbackのissuer/audience/nonce/state、未認証401、別user拒否、期限切れtoken拒否、現在のemail再検査、KV切替による全grant失効、runtime challenge |
| protocol         | MCP Inspectorでdiscovery/list/call、current headers、JSON response、`resultType` / cache hintsを確認                                                                                                                                |
| OpenAI extension | raw `tools/list` frameの `securitySchemes` 有無とChatGPT OAuth UIを確認。必要なら最小adapter                                                                                                                                        |
| ChatGPT          | Developer modeからOAuth、tool discovery、4 toolの実call、metadata Refreshを確認                                                                                                                                                     |

本番deploy前に `pnpm check`、MCP Inspector、local Workerを通す。ChatGPTのcallback URIはapp管理画面に表示される `https://chatgpt.com/connector/oauth/{callback_id}` を完全一致で登録する。固定の`callback_id`を仮定しない。

## Maintenance risk

| risk                               | 影響                            | 対応                                                                                       |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| Cosense内部APIの予告なし変更       | field/path/queryが壊れる        | endpointを4系統に限定、used fieldだけ検証、明確に失敗、公式CLI/releaseを更新時に確認       |
| vector/full-text index遅延         | 検索直後に新pageが出ない        | 候補選択後は必ずPages v2。SLAを約束しない                                                  |
| response上限の変更                 | 検索候補が欠落                  | observed valueを仕様化せず、returned/truncatedを返す                                       |
| related pagination変更             | 続きの候補が取れない            | `perPage=limit`、`hasNext/nextId`をopaque cursorとして往復                                 |
| rate limit非公開                   | 429や一時失敗                   | 1 call 1–2 request、N+1回避。429を明示し、無制限retryしない                                |
| OAuth / MCPの速い変更              | ChatGPT接続が壊れる             | current Cloudflare SDKへ委譲、version固定、manual metadata Refresh、定期的なdependency更新 |
| OAuth KV eventual consistency      | 認証直後の一時失敗              | OAuth用途に限定し、必要なら短時間後に再試行。DOを先行導入しない                            |
| Access / IdP credential失効        | OAuth login失敗                 | secret rotation手順のみREADMEに記載、token本文をlogしない                                  |
| Cloudflare quickstartの旧実装      | deprecated `McpAgent`を取り込む | current `mcp-worker` stateless exampleを基準にする                                         |
| ChatGPT protocol revision差        | discovery/call不成立            | deploy後にlive test。根拠なしのcustom互換layerは追加しない                                 |
| core MCPとOpenAI auth metadataの差 | tool-level OAuth UIが出ない     | raw frameをcontract test。公式supportを優先し、必要時だけ最小adapter                       |

## 確定した設計

Cosense側はsecretless、toolは上記4つ、本文cacheなし、stateless Worker、OAuth専用KVとする。本人確認はCloudflare Access for SaaS、許可email 1件、One-time PINに確定した。core MCPとOpenAIの `securitySchemes` extensionの接続点は、標準実装のChatGPT実機確認後に必要な場合だけ追加する。

## 調査成果物20項目の対応

|     # | 必須項目                       | 主な記載箇所                      |
| ----: | ------------------------------ | --------------------------------- |
|     1 | 既存MCPのread-only機能         | 「既存 `scrapbox-cosense-mcp`」   |
|     2 | 公式CLIのread-only機能         | 「Helpfeel公式 `cosense-cli`」    |
|   3–4 | endpoint、method、parameters   | 匿名実通信表、CLI表、各機能節     |
|   5–7 | 認証、secretless、実通信       | 「匿名実通信」「Cosense側secret」 |
|   8–9 | secretありだけの機能と差       | 「Cosense側secretの比較」         |
| 10–11 | vector仕様、full-textとの差    | 「Full-text と vector」           |
|    12 | Pages API v2                   | 「Pages API v2」                  |
|    13 | related / hop / Smart Context  | 同名節                            |
|    14 | 2026年release                  | 「2026年の関連release」           |
|    15 | 最新性 / cache / index         | 同名節                            |
| 16–17 | 採用 / 不採用                  | tool仕様、v1不採用表              |
|    18 | secretless / authenticated比較 | secret比較表                      |
|    19 | 推奨最終構成                   | 結論、Cloudflare architecture     |
|    20 | maintenance risk               | risk表                            |
