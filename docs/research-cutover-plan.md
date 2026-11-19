# 既存履歴を保全する読取専用cutover計画

`scripts/lib/research-cutover-plan.mjs` の `planResearchCutover` は、既存の
`auditResearchHistory` の実際のreportと、**すでに存在する権威ある共有台帳**を照合する。
返すのは保全差分・未解決の消費・保守的cutoffの候補だけであり、常に
`action: "hold"`、`activationReady: false`。

ファイル・遠隔台帳・旧writer・witnessを変更しない。台帳のgenesis作成、予約追加、
fitting、価格入力、結果の再計算、EA採用、取引、定期実行、認証情報の取得も行わない。
CLIや保存機能は追加していない。完全な計画には非公開の識別子・元reportのpathが含まれる。
公開repo、CIログ、stdoutへ完全計画を出さず、承認済みのprivate保管先だけで扱う。

## 入力契約

APIの入力は厳密に次の6フィールド。`readLedger` 以外はplain JSONであり、最初の
非同期待機の前に検証・複製する。getter、symbol、隠しfield、疎配列、配列上の追加field、
未対応fieldを拒否する。入力objectを凍結・変更せず、内部copyと結果を深くfreezeする。

```js
await planResearchCutover({
  binding,        // { ledgerId, repository, branch, path }
  readLedger,     // async (frozenBinding) => ledgerEnvelope
  checkpoint,    // 別途保存していた既存台帳のledgerEnvelope
  historyAudits,  // 既存history audit reportのenvelope配列
  missingSources,// 消費範囲が未照合の元記録と上限。原本の欠損・未解析を含む
  quarantine,    // cutoff提案のenvelope
});
```

`binding` は既存の同一private保存先を指す。`scopeHash` は `fingerprint(binding)`。
`fingerprint` は既存 `virtual-autonomy.mjs` のcanonical JSON SHA-256であり、raw fileの
SHA-256とは異なる。価格や認証情報をbindingへ含めない。

### 既存台帳と保持済みcheckpoint

`checkpoint` と `readLedger` の各応答は同じ形式にする。

```js
{
  schemaVersion: 1,
  timeUnit: "UTC epoch milliseconds",
  scopeHash: fingerprint(binding),
  snapshot: { version, document },
  documentHash: fingerprint(document),
}
```

`document` は既存のschemaVersion 1共有台帳を**そのまま**渡す。revision、consumedBefore、
予約の順序、attempt、reservedAt、完了のresultHash/completedAt、batch全員を保持する。
未知のschema拡張は黙って削らず拒否する。旧reportの `proposedLedger` をこの既存台帳や
checkpointの代わりにしてはいけない。欠損した台帳を空台帳で補わない。

`readLedger` は承認済み既存保存先のread-only readerに接続する。引数の固定bindingを使い、
reader自身も書込・bootstrapを行わないこと。ライブラリはwrite callbackを受け取らない。
既存connector/storeのread応答を上記envelopeに包めるが、envelopeを作るだけで独立した
custody、private visibility、権威性、freshnessを確認済みにはしない。

最初のreadを保持済みcheckpointと比較し、次のreadを最初のreadと比較する。既知recordの
削除・並替え・改変、完了の取消し、cutoff/revisionの回帰、版を変えない本文変更を拒否する。
正しいreserved→completed遷移や追記がcheckpoint以後に起きていれば、最新の全recordを保つ。
ただし計画中の2回のreadで本文かopaque versionが変わればcandidateはnullになる。
応答消失・破損では自動再試行や書込をせず停止する。

### 既存history audit report

```js
{
  schemaVersion: 1,
  timeUnit: "UTC epoch milliseconds",
  sourceId: "preserved-checkpoint-a",
  reportHash: fingerprint(report),
  report, // auditResearchHistory(...) の返した未改変の全object
}
```

reportのmanifest hash、各journalのhash/head、selected report、全blockerをそのまま結果へ
保持する。`report.proposedLedger` は既知の旧予約を照合するためだけに使う。旧予約は当時の
identityから決まる `legacy_...` attempt、reservedAtも含めて一致しなければならない。
既存台帳にその予約がcompletedで保存されていれば、完了状態・結果hashを保つ。

reportの形・hash・件数・最終区間は検証するが、保存済みreportを受け取ることは原本全体の
再監査ではない。原本のmanifest pinが一致していても、別の実験元や有効なprefixだけが
残った履歴の完全性は証明できない。`manifestPinMatched` や `fullSourcePresent` を独立した
安全証明へ昇格させない。正しい全reportとその元資料は別途保全が必要。

### 未照合の元記録とcutoff提案

`quarantine` は次の形式。

```js
{
  schemaVersion: 1,
  timeUnit: "UTC epoch milliseconds",
  consumedBefore: /* 排他的UTC-ms cutoff */,
  recordedAt: /* 提案根拠を記録したUTC-ms時刻。cutoff以上 */,
  evidenceHash: /* 根拠資料のSHA-256 */,
  reason: /* 人が読める根拠の説明 */,
}
```

`missingSources` は名前にかかわらず、原本欠損だけでなく、原本はあるが消費範囲未解析の
元記録も含む。各項目は同じ形式に `sourceId` と `sourceHash` を追加する。
`sourceHash` はその元ファイルの既知SHA-256、不明な場合だけnull。
消費範囲の上限が不明なら `consumedBefore: null` にして明示的に停止する。

**すべてのselected reportの各sourceHash**に対応したmissingSourceと非nullの上限が必須。
`fullSourcePresent: true` も例外にしない。この値は原本のhash在庫確認だけであり、既存auditは
その全試行の消費期間をparseしていない。原本があることを消費範囲の照合済みと扱わない。
別sourceIdや一般的な説明だけで全部を保護済みとは扱わない。
対応がなければ `selected_legacy_source_missing_hash_bound`、上限自体が不明なら
`missing_source_consumption_bound_unknown` がplanning blockerになる。対応した資料があっても
その上限・資料のcustodyは独立未検証のまま。

全ての独立したpersisted入力に正確な `timeUnit` を要求し、外側に一度だけ書いて済ませない。
時刻は2000-01-01以上2100-01-01未満のsafe integer UTC-msだけを受け取る。秒・microsecond・
小数・範囲外の古い資料を推測変換しない。既存台帳のcutoff=0だけは「未設定」の既存表現と
して保持する。古い単位未宣言reportをwrapperに入れる前に、元の時刻単位を別途確認すること。

入力全体8 MiB、read応答2 MiB、source総数64、台帳予約数2048、統合した旧予約数2048などを
上限にする。上限超過時に切詰め・自動archive・消費の忘却を行わない。別途設計が必要。

## 照合結果と変更候補

- `existingLedger` と `checkpoint` はcandidateがnullでも全て残す。
- `historyAudits` / `missingSources` は入力の資料・未解決事項をそのまま保持する。
- `legacyReportSources` はすべてのselected元hashと明示した上限の対応を示す。
  `reports` に原本の有無を残すが証明にはせず、対応した根拠sourceを `boundSourceId` で示す。
- `reconciliation` は完全一致、欠損、既存台帳との競合、旧source同士の競合を列挙する。
- cycle/attempt/test hashの使い回しや期間重複を、名前を変えた新しい研究とは扱わない。
- 既存tailより前に足りないrecordが見つかったら、append-onlyの順序を壊して挿入・sortしない。
  cutoffがその区間を覆っていても欠損は解決しない。`proposedLedger: null` として別途復旧判断を
  要求する。tailより後の欠損もこのplannerでは自動追加しない。
- `quarantine.requiredKnownCutoff` は既存cutoff、全既知区間の終端、明示されたmissing source
  上限の最大値。提案cutoffがこれを下回る場合や回帰する場合はcandidateを返さない。
- 全て照合できた場合だけ、既存documentの予約を一つも変えないcutoff-only candidateを作る。
  cutoff変更時だけrevisionを正確に1増やし、同値ならrevisionも維持する。overflowでは停止する。
- `preservation` は保持数・全予約hash・reserved/completed/batch数、変更する2fieldだけを示す。
  `planHash` は返した計画の他の全field、`proposedLedgerHash` は候補本文をそれぞれ束縛する。

candidateはCASの実行許可ではない。適用までに台帳が進む可能性もあり、実際の適用・receipt・
独立witnessへのbind・障害耐久性確認は実装していない。`[0, consumedBefore)` を隔離しても、
**その時刻以後が未使用である証明にはならない**。新しいwitness genesisやactivation certificate
へ変換してはいけない。

## 必ず残る有効化blocker

全実験元のinventory、旧経路の停止、根拠の独立custody、fresh authoritative read、private保存先、
write-ahead witnessのcutover、条件付き適用・耐久性、observed runnerの受入は別々に必要。
callerの `sourcesComplete: true` / `quiescenceVerified: true` のようなfieldは受け付けない。

一部コードのobserved経路を停止しただけでは、すべての旧writerの停止を証明できない。
手動で呼べる旧 `tune-virtual-strategies`、別PC・別branch・過去版・中断processを含むwriter一覧と
retirementが未確認であり、`legacy_evaluation_quiescence_not_proven` は常に残す。
合成fixtureのgenesisだけを、旧消費を保全したcutoverの証拠としてはいけない。

## 合成テスト

```bash
npx vitest run scripts/lib/research-cutover-plan.test.mjs
```

架空の時刻・hash・reservation・checkpointだけを使う。実際の `auditResearchHistory` から
合成checkpointのreportを作る統合試験も含む。完了/batch保全、欠損旧区間、renamed period、
hashで結び付いた欠損/原本存在未解析の元記録とその混在、mixed units、疎配列、上限、入力/応答mutation、二度のreadの不一致、
checkpoint rollbackを検査する。実private入力、実provider、実価格での確認ではない。

関連: [履歴監査と独立anchor](research-history-and-rollback-anchors.md)、
[旧記録の移行準備](research-migration-planning.md)、
[共有予約台帳](shared-research-reservations.md)、
[合成write-ahead witness](synthetic-write-ahead-witness.md)。
