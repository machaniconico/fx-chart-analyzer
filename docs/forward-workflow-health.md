# 日次 EA 仮想運用の実行結果と公開可用性を分ける

`Run EA forward tests` は既存の soft-fail 設定を維持する。取得した価格や他の集計が
既存の鮮度検査を通る限り、仮想戦略の再計算失敗だけでサイト全体の公開を止めない。
これは失敗を正常扱いする意味ではない。

公開と既存の最終鮮度・永続化検査の後に、今回の forward step の `outcome` が
`success` だったかをハードゲートで確認する。`continue-on-error` が成功へ変える
`conclusion` は使わない。失敗・skip・空・未知の結果は異常として run を失敗させる。
キャンセル時はこの追加検査を行わず、キャンセルを正常完了に変えない。

これにより、前回の `computedAt` がまだ鮮度閾値内でも、今回の失敗を green badge で
隠さない。既存の failure issue 経路が結果を記載し、失敗中の自動復旧扱いを防ぐ。
Issue 作成自体や GitHub の配送が失敗しない保証はない。定期点検は引き続き必要。

## 公開・保存に対する影響

- forward が失敗しても、既存 pre-commit gate を通ればデータ保存・公開は継続し得る。
  仮想成績が前回値のまま、あるいは処理が途中まで進んだ状態になる可能性は既存と同じ。
  新しい検査はこれを成功と呼ばず、処理の atomicity や鮮度閾値を変更しない。
- 既存の鮮度検査が拒否した場合の保存・公開阻止は変えない。
- 公開後に追加ゲートが失敗しても、既に公開したものを巻き戻さない。
- upstream で別の処理が失敗して forward が skip された場合も失敗を記録する。
- データ検査の成功、forward step の成功、採用戦略数や保存結果の検証は別の事実。
  step 成功だけで期待した全データが更新されたとは断定しない。

既存 7 戦略と 37 観察戦略の日次 OHLC シミュレーションだけを対象とする。
新しい自律選択、実データ研究の安全条件、PR #175、実口座売買は変更しない。

## ローカル検証

`npx vitest run scripts/forward-workflow-outcome.test.mjs scripts/report-schedule-timing.test.mjs`
は workflow の境界・配置・通知経路を確認し、実際のゲートの shell を
success/failure/skipped/cancelled/空/未知の outcome で実行する。
これは GitHub Actions エンジンや実際の Issue 配送の end-to-end 試験ではない。
