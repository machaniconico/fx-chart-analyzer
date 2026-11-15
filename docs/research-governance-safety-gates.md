# 時刻・採否・実行の安全境界

2026-11-15更新。仮想研究のみ。既存EA、確定成績、予約、privateデータ、日次workflowは変更しない。

## 修正した3つの抜け道

1. 研究runnerはUTCミリ秒だったが、独立採否gateの履歴閾値とrouterの最低維持期間は秒で比較していた。架空入力で20時間を730日以上、90秒を24時間以上と判定する再現を修正した。
2. 旧 `runResearchCycle` は `kind: observed` と通常の共有storeだけで、履歴移行・独立witnessが未検証でも候補評価へ進めた。最後に `hold` を返してもholdout消費を防げない。今は観測入力を**評価・状態directory作成・台帳のread/writeより前に拒否**する。
3. 採否gateが使用済み期間を確認する対象は最終holdoutだけだった。今はすべてのouter foldと最終holdoutについて、期間の重複と内容hash・IDの再使用を検査する。fold内の重複、最終holdoutとの内容/ID共用、欠損した識別子も不合格。別保存の使用済み記録にもmsのtimeUnitを要求し、秒のまま比較して重複を見逃さない。

## 明示的なUTCミリ秒契約

新しいpolicyはversion 2。新candidateはschemaVersion 2で、`timeUnit: 'UTC epoch milliseconds'` をidentityに含める。

- `freezeCandidate`、`evaluatePromotion`、`selectVirtualCandidate`、`classifyRegime` は明示的なtimeUnitを要求する。candidate/evidence/regime/policyの欠落・不一致は拒否または待機。数値の桁数から推定・自動変換しない。
- `splitPurgedSamples`、`closedBarsAsOf`、`conversionAsOf` も同じ単位を明示する。`timeframeMs`、`embargoMs`、`maxAgeMs` を使う。
- 730日は `730 * 86400000`、最低維持期間は `minDwellMs: 86400000`、鮮度は `maxFeedAgeMs` で比較する。新しい審査・選択の日時は非負のsafe integer。小数や安全範囲外を受け付けない。過去の汎用audit chainは元の検証契約を維持し、予約などのdomain-specific importerが時刻を別途確認する。
- 旧candidate/registryは自動更新せず拒否する。履歴は保存したまま、新規registry・新しい世代として明示的に移行するまで利用しない。
- 既存公開OHLCファイルの秒timestampは変更しない。読取専用の `audit-virtual-autonomy.mjs` が境界で一度だけ1000倍し、schemaVersion 2の監査はmsを明記する。表示用の `ageSeconds` は名前どおり秒である。

タグやhashは真正性の証明ではない。採否gateに渡す真偽値は実検証を行ったシステムが生成する必要があり、手書きの `pipelineReplay: true` 等を検証完了と扱わない。観測runnerの接続が未検証な現時点で、この関数だけを自動採用に直結しない。

## 観測経路は停止、読取検証は可能

`run-virtual-research.mjs --demo STATE_DIRECTORY` は継続して合成fixtureのみを実行する。旧形式の観測REQUEST/LEDGER_CONFIGを渡すと、ファイル・認証情報の読み込みやネットワーク接続より前に終了コード2で停止する。readinessらしい真偽値を要求やstoreに付けても解除できない。

既存のcapture import、hash/chronology/品質チェックは戦略評価ではないため、読取検証に使える。過去に消費されたholdoutを再計算しない。履歴の完全性が不明な区間を「既知予約の直後だから未使用」と推定しない。観測価格はrepositoryやCIへ含めない。

観測評価の再開には、全履歴の照合または根拠を記録した保守的cutover、独立witnessの権限・保持・fresh read/CAS、保護されたobserved runnerの接続と実障害試験が必要。現在のAPIに許可flagを追加するだけでは再開しない。

## 結果回復

合成write-ahead runnerには任意のimmutable artifact storeを追加した。成果物を保存・正確に再読取してから完了を書き込む。**台帳とwitnessの両方が完了済み**で、request・engine・plan・attempt・両保存先identity・成果物hashが一致するときだけ、保存済みの同じ成果物を返す。評価や新しいwriteは行わない。

未解決intent、片側のみの完了、欠損・改変cacheは自動回復しない。記録を消したり再評価したりして復旧しない。ローカルcacheは独立した管理境界や実providerのdurabilityを証明しない。[write-aheadモデルと回復の詳細](synthetic-write-ahead-witness.md)を参照。
