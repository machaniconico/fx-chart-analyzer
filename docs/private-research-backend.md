# 非公開研究台帳の保存先と接続準備

## 方針

共有台帳は、公開するFXアプリのコード・データと分離した専用の非公開領域に置く。既存の別用途プロジェクトは流用しない。台帳に送るのは識別用ハッシュ、使用済みテスト区間、試行ID、状態、結果ハッシュだけ。価格テープ、個人情報、認証情報、要求全体、成績の明細は送らない。

現時点のコードは準備段階。保存先の作成・接続、認証情報の追加、実観測データを使う新規実験、定期実行の有効化は行わない。

## 候補の比較

### 第一候補: 専用の非公開GitHubリポジトリ

既存の接続済みGitHubを使える場合、追加の認証情報をコードへ渡さずに `fetch_file` と、取得したblob SHAを条件にする `update_file` を利用できる。既存の `createGitHubReservationStore` を維持する。

- 専用リポジトリ、既存ブランチ、固定パス、固定 `ledgerId` を確定し、非公開性と既存の読書き権限をmetadataで確認する。
- 初期READMEを持つ専用リポジトリを作っても、接続済みアプリから見えるとは限らない。アクセス範囲の追加が必要な場合は自動で行わない。
- 接続ツールは同じパスへの並行更新を禁止している。順番に行う「古いSHAの更新拒否」は確認できても、それだけで独立クライアントの同時更新試験済みとは言わない。必要な試験は、適切に許可された別の実行経路を用意してから行う。
- Gitの履歴は復旧資料になるが、管理者による強制更新・削除・巻戻しを防ぐものではない。保護設定、バックアップ、信頼できる最新状態との照合は別に必要。

### 代替候補: Vercel Private Blob

公式資料では、private blobの `get(..., { useCache: false })` が最新の内容を直接取得し、`put(..., { ifMatch: etag })` が条件付き更新を行う。専用の `BlobPreconditionFailedError` が競合を示す。

`scripts/lib/research-blob-store.mjs` はこの契約に沿った**合成試験専用**のアダプター。実SDKはインストールせず、既に許可済みのSDK関数を注入する形だけを用意した。CLIやジョブへ接続していない。返すstoreは凍結され、`syntheticOnly: true` を変更できない。

- `storeId` とJSONのパスを固定し、privateアクセス以外は指定できない。返却URLも、指定storeのprivateホストと一致する必要がある。
- 本文とETagを一つの非キャッシュ読取で得る。`head` と `get` の間で版が変わる競合を避ける。
- 毎回、観測したETagを `ifMatch` に設定し、ランダムなパス、multipart、公開アクセス、無条件上書きへのフォールバックは使わない。
- 成功応答だけで進まず、共有予約の制御側で再読取し、一意な試行IDと予約・結果の完全一致を確認する。
- SDKの専用競合クラスだけを安全な競合とする。名前やHTTP statusだけが似た例外、タイムアウト、未知の応答は未確認として止める。
- 本文の1 MiB上限、不正UTF-8、サイズ不一致、別パス、弱いETag、ワイルドカードを拒否する。1 MiBを超えた際は停止し、自動で分割・消去しない。
- SDKの内部再送を避けるため、書込みの直前に `VERCEL_BLOB_RETRIES=0` を必須とする。アダプター自身は環境変数を書き換えない。
- SDKはread-write tokenへフォールバックすると `storeId` をトークンから決めるため、この準備実装は `BLOB_READ_WRITE_TOKEN` の存在を拒否する。許可済みのstore限定OIDCがない場合は失敗する。トークンを抽出・作成・保存せず、開発用の接続先・API版・プロキシの環境変数も拒否する。

Blobはファイル保存サービスであり、これだけで履歴の保持・改変防止・災害復旧が保証されるわけではない。新規storeの作成やOIDC接続は、保存先・課金・アクセス範囲の確認が済むまで行わない。

### 今回は採らない経路

- 現在のDriveファイル更新ツールは、更新条件のETag/版を受け取らない。単に更新後を読み直すだけではlost updateを防げない。
- 現在のDropboxアップロードツールは新規ファイル保存であり、この共有台帳に必要な条件付き置換の経路ではない。
- 新しいDBサービスの導入はアカウントや認証・権限設定を伴うため、既存GitHubが使えないことだけを理由に自動導入しない。

## 遠隔試験の開始条件と手順

1. 保存先とデータ用途の許可、非公開性、読書き権限、保持方針、復旧手段、費用を確認する。新しい永続アクセスの作成は別に承認を得る。
2. 実台帳とは別の固定パスと `ledgerId` で、合成データだけの試験領域を作る。実台帳を削除・初期化・巻戻しして試さない。
3. 使用するSDKのバージョンを固定し、実際の送信でprivate/store指定、origin読取、ETag条件、競合エラー、内部再送停止が機能することを確認する。今回の模擬SDK試験はこれを代替しない。
4. 独立クライアントの競合、古い版の拒否、応答喪失、読取不能、予約後と完了前後のプロセス終了を試す。結果には実施した試験だけを記録する。
5. 独立して保存された信頼できる最新の台帳版・ハッシュと、再起動時の読取を照合する。**前のsnapshotを持たない新しいプロセスは、形式の正しい古い台帳への巻戻しをこのアダプターだけでは検出できない。** 最新の基準が失われた場合は空から再開しない。
6. [旧記録の移行案](research-migration-planning.md)を全履歴と照合し、失敗・中断を含めて使用済み区間を保つ。消費済みデータを新品扱いしない。
7. ここまで完了した後にだけ、実観測データの接続を別の変更として検討する。定期実行、採用、実口座接続、注文はこの変更の範囲外。

## 今回の試験の意味

Blobアダプターの試験はすべてローカルの模擬SDKによるもの。独立したアダプター同士の競合、条件付き更新、応答喪失後の照合、古いsnapshotとの後退検出、入力・接続設定の拒否を検証する。実サービスへ書いていないため、実サービスの同時更新・保持・プロセス終了後の復旧を検証済みとはしない。既存のSIGKILL試験は合成データ用のファイル保存実装を対象としており、Blobの証拠ではない。

## 一次資料

- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#create-or-update-file-contents)
- [Vercel Blob](https://vercel.com/docs/vercel-blob)
- [Vercel Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk)
- [Vercel Blob private storage](https://vercel.com/docs/vercel-blob/private-storage)
- SDK実装の確認先: [api.ts](https://github.com/vercel/storage/blob/main/packages/blob/src/api.ts)、[helpers.ts](https://github.com/vercel/storage/blob/main/packages/blob/src/helpers.ts)、[get.ts](https://github.com/vercel/storage/blob/main/packages/blob/src/get.ts)、[put-helpers.ts](https://github.com/vercel/storage/blob/main/packages/blob/src/put-helpers.ts)。mainの確認は実行に使うSDKのバージョン固定・検証ではない。
