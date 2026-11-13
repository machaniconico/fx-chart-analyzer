# synthetic専用のwrite-ahead witnessモデル

これは、将来の安全な継続研究のための**非稼働protocolモデル**。実際の独立witnessサービスを作成・接続せず、既存台帳・EA・データ・workflowも変更しない。観測データの評価、定期実行、自動採用、取引、有効化は行わない。

`witnessed-synthetic-outer-replay.mjs` は固定された内蔵synthetic計画だけを受け取る。外部の価格、評価callback、scenario、部分foldは入力できない。返す成果物は常に `action: hold`、`eligible: false`、`activationReady: false`。内蔵価格での結果を収益性の証拠と扱わない。

## 書込順序

1. 明示された既存witnessと台帳を読み、保存先識別子、独立に保持したcheckpoint、全eventのhash鎖、台帳の正確な状態を照合する。欠損からの自動初期化や新baselineへの置換はしない。
2. 計画全体の全holdout区間、request/engine/test hash、一意な実行attempt、開始時の台帳version/本文hashをwitnessへCASで追記する。正確なreceiptを再読取する。このintentが記録された時点から全区間を消費済みとする。
3. 共有台帳で全foldを一括予約する。確認できた全予約と台帳snapshotをwitnessへ追記し、再読取する。
4. 両方をもう一度読み、同じ予約状態とwitness checkpointを確認した後だけ内蔵synthetic評価を行う。ロード済みソースの不変性と評価結果のtest hashも確認する。
5. 全成果物hashで共有台帳を完了し、その正確な全foldの完了receiptをwitnessに追記する。両方を再読取して一致した時だけ結果を返す。

witnessは既存台帳のbaseline全体を保持し、その後の予約・完了snapshotを鎖として追加する。既存予約、使用済みcutoff、各batchの全メンバーを削除・短縮・別所有者に変更できない。未記録の台帳更新、同じversionでの内容変更、不明phase、巻戻し、hash不一致は停止する。

witnessのCASは再送しない。応答が失われても、期待した**正確な追記全体**が再読取できれば先へ進める。それ以外は明示的な競合でも停止する。台帳CASは既存の共有予約controllerを使う。

## 部分成功・再起動

| 中断時点 | 残る状態 | 再起動時 |
|---|---|---|
| 最初のintent書込前 | 予約も評価もなし | 新attemptで開始可能 |
| intentだけ記録 | 全区間がwitnessで消費済み | 未解決intentとして停止 |
| 台帳予約後、witnessへのbinding前 | intentと台帳が不一致 | 復旧が必要として停止 |
| 両予約の確認後 | 未解決intentと全予約が残る | 自動引継ぎ・再評価をしない |
| 台帳完了後、witness完了前 | 片側のみ完了 | 復旧が必要として停止 |
| 両方完了後 | 全区間・結果hashが確定 | 同じ/重複する区間の再評価を拒否 |

自動復旧、leaseの期限切れ、予約解除、未解決intentの飛越しは実装しない。失敗は評価データを浪費し得るが、使用済みの区間を再利用する方向へは回復しない。成果物をdurableに保存して再読取する仕組みも未実装なので、完了後に返答を失った場合の結果回復は別途必要。

`inspectSyntheticWitness` は読取専用。整合している場合も有効化可能とは返さない。台帳にまだ書かれていない未解決intentの全区間も返す。台帳との不一致は例外で停止し、その不一致を新baselineへ吸収しない。

## 信頼境界

- 注入したstoreの `authorityId` が異なることは確認するが、単なる名前の違いで管理境界の独立性を証明するものではない。実環境では研究writerがwitnessの削除・復元・retention変更をできないことを別途検証する必要がある。
- storeはfreshで権威あるreadとatomic CASを提供する契約。暗号hashだけでは古い応答や、両保存先がそろって過去へ戻った状態を判別できない。
- `trustedCheckpoint` は明示必須。保持したcheckpointより古いwitnessは拒否するが、両側が同じ古い状態に巻戻され、入力pinも古ければ自己整合性だけで検出できない。この限界はテストで明示する。返却された新pinを同じwriterの通常ファイルに保存するだけでは独立保管にならない。
- 2つの保存先を跨ぐatomic transactionはない。最後のreadの直後にproviderがrollbackすることをコードだけで防げない。witnessの追記が不可逆で、読取がfreshであることが前提。
- baselineを作る `syntheticWitnessGenesis` はテストfixture専用。履歴の完全性や保守的cutoverの証明ではない。稼働runnerは欠損witnessを作成しない。
- witnessは2 MiB・300eventまで。容量不足は停止し、古い記録を自動削除しない。別途検証したarchival/checkpoint protocolが必要。

## 検証の範囲

ユニットテストは、書込順と評価開始時点、全fold照合、応答喪失、片側成功、古い応答、両方向の巻戻し、独立pin、並行attempt、未知field、短縮receipt、別所有者・結果差替え、入力の途中変更、既存cutoffの保持を検査する。

別processのテストでは、5つの書込それぞれの直前/直後でSIGKILLし、再起動が既存消費を再利用しないことを確認する。2つのprocessの競合も検査する。テストの2ファイルは同じローカルfilesystem上にあり、**独立した管理境界、remote CAS、ネットワーク分断、OS/power-loss、provider retentionの証明にはならない**。

## 観測データへ進める前の残り

1. 旧tuner等を含む全履歴の照合、または旧評価経路を停止して記録した保守的cutover。未確定な過去holdoutを未使用とは扱わない。
2. 承認済み独立witnessの管理境界・保持・認証・fresh read/CAS・実障害復旧の検証。既存private台帳の全消費状態を保持する。
3. 実runnerのwrite-ahead接続、成果物のdurable保存、明示的な復旧と結果回復、完全な実環境のクラッシュ試験。
4. 観測nested outer評価、代表的な長期データ、資金調達・流動性・証拠金、router/allocatorの検証。

この変更は上記の有効化条件を解除しない。既存draft PRはdraftのままにする。
