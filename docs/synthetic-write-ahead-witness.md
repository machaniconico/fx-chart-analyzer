# synthetic専用のwrite-ahead witnessモデル

これは、将来の安全な継続研究のための**非稼働protocolモデル**。実際の独立witnessサービスを作成・接続せず、既存台帳・EA・データ・workflowも変更しない。観測データの評価、定期実行、自動採用、取引、有効化は行わない。

`witnessed-synthetic-outer-replay.mjs` は固定された内蔵synthetic計画だけを受け取る。外部の価格、評価callback、scenario、部分foldは入力できない。返す成果物は常に `action: hold`、`eligible: false`、`activationReady: false`。内蔵価格での結果を収益性の証拠と扱わない。

## 書込順序

1. 明示された既存witnessと台帳を読み、保存先識別子、独立に保持したcheckpoint、全eventのhash鎖、台帳の正確な状態を照合する。欠損からの自動初期化や新baselineへの置換はしない。
2. 計画全体の全holdout区間、request/engine/test hash、一意な実行attempt、開始時の台帳version/本文hashをwitnessへCASで追記する。正確なreceiptを再読取する。このintentが記録された時点から全区間を消費済みとする。
3. 共有台帳で全foldを一括予約する。確認できた全予約と台帳snapshotをwitnessへ追記し、再読取する。
4. 両方をもう一度読み、同じ予約状態とwitness checkpointを確認した後だけ内蔵synthetic評価を行う。ロード済みソースの不変性と評価結果のtest hashも確認する。
5. 任意のsynthetic artifact storeがある場合は全成果物を不変保存し、正確な再読取を確認する。その後、全成果物hashで共有台帳を完了し、その正確な全foldの完了receiptをwitnessに追記する。両方を再読取して一致した時だけ結果を返す。

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
| 両方完了後 | 全区間・結果hashが確定 | 再評価を拒否。明示cache利用時の同一requestは検証済み保存結果のみ回収可能 |

自動復旧、leaseの期限切れ、予約解除、未解決intentの飛越しは実装しない。失敗は評価データを浪費し得るが、使用済みの区間を再利用する方向へは回復しない。明示cacheを渡した場合だけ、下記の限定的な完了結果回復を利用できる。cacheなしでは完了後の結果回復も拒否する。

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

## 追加: synthetic成果物の限定的cache回復

`runWitnessedSyntheticOuterReplay` に `syntheticOnly: true`、`put(resultHash, artifact)`、`read(resultHash)` を持つ明示的なstoreを任意で渡せる。観測価格、評価callback、新しい評価器は追加しない。

cache利用時は、全成果物をhashで不変保存し、**完全一致した再読取を確認してから**台帳を完了する。書込応答が失われても再送せず、正確なreadbackだけで照合する。ただしlocal helperが明示的な書込・file/directory fsync失敗を返した場合は専用のfatal errorで停止する。読めるcache bytesがあっても永続化成功とは扱わず、台帳を完了しない。storeの方法、計画、checkpointは最初のawait前にsnapshotする。storeにはコピーを渡すので、そのコピーの変更で元の成果物は変化しない。成果物にはledger scope、attempt、予約全体、witness予約checkpoint、計画とengine sourceを保持する。artifact helper自身もengine source hashの対象となる。

同一requestの再実行は、未解決intentが一切なく、両authorityが全履歴と完了状態で正確に一致し、該当する一つのattemptの保存成果物が完了receiptのhash・計画・code・全識別子と一致した場合だけ、その成果物を返せる。再fit、再評価、台帳やwitnessの更新は行わない。最後にもauthorityを再照合する。cache欠損、破損、別attempt、変わった計画/code、片側完了、未解決intent、保存後かつ完了前の中断はすべて停止する。欠損結果の再計算、未解決attemptの引継ぎや完了再送はしない。古い完了にcacheが無い場合も停止する。

`createLocalSyntheticArtifactStore({ directory })` はLinux専用のローカルhelper。明示された既存の絶対directoryだけを利用し、自動作成しない。全祖先をdirectory descriptorと`O_NOFOLLOW`で辿り、各操作は固定descriptorからの相対アクセスを使う。directory差替え、symlink、hardlink、非regular file、経路脱出、上書きは拒否する。ファイル名は64桁のresult hashから生成する。8 MiB上限、canonical JSON、内容hashを照合し、読取も上限を超えて消費しない。作成はexclusiveで、fileとdirectoryをfsyncする。失敗した部分ファイルも削除・修復しない。

これは信頼されたlocal filesystem上の限定的なprocess再起動cacheであり、OS/power-loss、独立保管、remote provider retention、悪意のある同一ユーザーによる同時ファイル変更、権限境界の証明ではない。ローカル書込の不変性はこのhelperのAPIで強制するもので、管理者や別processの直接変更を防ぐものではない。既存の両authorityと独立pinの信頼条件はそのまま残る。

追加テストでは不変保存、cache再読取、欠損・破損・別attempt、入力methodの変更、非synthetic store、symlink/hardlink/unsafe path、directory差替え、過大ファイル、legacy完了にcacheがない場合を検査する。別processのSIGKILLをcache保存前後および両完了前後に注入し、両方完了後だけ保存結果を回収でき、それ以外は台帳/witnessを書き換えず停止することを確認する。観測評価への有効化条件は解除しない。
