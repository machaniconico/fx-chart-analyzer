# 日次データ更新の起動遅延

> 以下は2026-11-16時点の調査記録。公開の排他制御と待機キューの現行設計は [publish-serialization.md](publish-serialization.md) を参照。

調査日: 2026-11-16。対象は既存の日次データ更新のみ。研究用の自律選択、実口座、PR #175 の cutover 計画は変更しない。

## 確認できた原因の範囲

[11月16日のrun](https://github.com/machaniconico/fx-chart-analyzer/actions/runs/43781903389) は、当時の `0 21 * * *`（06:00 JST）に対して次の時刻だった。

- 名目の起動予定: 2026-11-15 21:00:00 UTC（翌日06:00 JST）
- workflow作成: 2026-11-16 00:41:52 UTC（09:41:52 JST）
- job作成: 00:41:53 UTC、runner開始: 00:41:55 UTC
- job完了: 00:46:32 UTC

約3時間42分はworkflowが作成される前に生じた。作成後のrunner待ちは約3秒、job本体は4分37秒。データ取得は7秒、最も長いscanner統計も3分10秒で終わっている。したがって、この日の遅れを取得処理のハングや90分timeoutで説明することはできない。直前の日次runや同時刻の別runによる待機も、確認した履歴にはない。

同じcronを使った直近8回（11月9〜16日）の作成時点の遅れは、最も近い名目時刻から約209〜368分。これは1回だけの遅延ではない。

[GitHub公式のschedule説明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) は、特に毎時00分などの高負荷時に遅延や欠落が起き得るとして、毎時の開始を避けるよう勧めている。今回の観測はこの説明と整合するが、GitHub内部の個別障害・混雑原因までは公開記録から確定できない。

## 修正範囲

1. cronを一日一回の `17 21 * * *`、**06:17 JST起動予定**へ移す。06:00完了の保証や、定刻実行の保証ではない。
2. 同じ `update-data` concurrency group と `cancel-in-progress: false` を維持する。データpushからPR作成の間に実行を中断しない。GitHubがpending runを置換する場合があるため、厳密なFIFOやexactly-onceとは呼ばない。
3. concurrency取得後のcheckoutで `ref: main` を明示し、長く待機したイベントの古いSHAから日次データを作り直すことを避ける。
4. jobはmain上のschedule/manual実行だけに限定する。別ブランチを手動選択して公開更新を走らせない。
5. 開始時に、GitHubのrun metadataを一度だけ読む。名目時刻、workflow作成、今回のattempt開始、計測時刻をActions summaryへ記録し、作成遅延が30分以上ならwarningを出す。

時刻取得の失敗や遅延そのものを理由に、データ更新を止めない。従来のpre-commit/final freshness・永続化チェックはhard gateのまま。データ取得、キャッシュ、統計、forward実行、データPR、公開データ、既存の取引設定は変更しない。遅延を取り戻すための追加cron、外部dispatch、自動リトライは追加しない。

## 時刻の限界と安全性

GitHubのrun metadataには、そのrunが本来どの日のcronから発生すべきだったかを証明する時刻がない。計測値は**workflow作成前の最も近い予定時刻からの遅延の下限**。24時間超の遅れや、完全に落ちた予定を復元した値ではない。再実行は元runの作成時刻を保持し、新しい日次起動として数えない。手動実行にはcron締切を推測しない。

warningはActions内の観測であり、利用者への通知や、起動しなかったrunの検知を保証しない。別の読取専用点検で、予定後にrunが作成されたか、成功したか、mainと公開物のデータが新しいかを確認する必要がある。点検から無条件に再実行を開始しない。

今回の変更は同じ日次workflowの並行実行を増やさないが、repository外部からの更新や別workflowのデプロイまで単一トランザクションにするものではない。既存の `deploy.yml` とはconcurrency groupが異なる。この範囲まで改善する場合は、最新mainの照合と公開順序を別途設計・検証する。

## 検証と導入判断

```sh
npx vitest run scripts/report-schedule-timing.test.mjs
npm test
npm run build
```

時刻計算・日跨ぎ・30分境界・再実行・手動実行・不正metadata・失敗時の再送禁止と、workflowの単一cron・非キャンセル直列化・hard gate保全をテストする。実際のscheduleを起動して検証してはいない。

この修正はドラフトPRで確認する。取り込んだ後の数回について、作成遅延が減ったか、公開更新が成功したかを実測してから有効性を判断する。GitHub scheduleだけで期限を保証する必要が出た場合は、別schedulerの認証・排他・冪等性・費用も含めた設計が必要。
