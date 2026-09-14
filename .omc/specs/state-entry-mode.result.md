# State entry mode 実装・検証結果

実施日: 2026-09-14。ブランチ: `feat/state-entry-mode`。初稿・修正: Codex/Astra（このタスクのユーザー指定により外部モデル呼び出しなし）。

## 検証

- `npx vitest run`: `Test Files 33 passed (33)` / `Tests 877 passed (877)`（最終実行 2026-09-14 15:08 JST）。
- `npm run build` (`tsc -b && vite build`): 成功。Viteの500 kB超チャンク警告あり。
- `node scripts/run-forward-test.mjs`: 採用7EA・観察31件、確定日追加はいずれも0。`results.json` と `observation-results.json` の `computedAt` 各1行のみ変更。その他の行はバイト同一。確認後 `git checkout -- public/data/forward/` で復元し差分0。
- 既存18型のMQLスナップショット差分0。新型2種×MQL4/5、およびCCI cooldown=3×MQL4/5の6件のみ追加。
- 新型はindex 18/19、各12候補×280組合せ（合計6,720）。既存型の候補ID・magic・パラメータ範囲・展開は回帰テストで固定。
- クールダウンは仕様式 `index < closeIndex + N` に従う。N=3なら決済バーcで探索せず、c+3の確定足で探索再開、c+4始値で約定。MQLはshift 1を評価するため `iBarShift(lastClose) - 1 >= N` で同じ境界とする。0/省略時はMQLに履歴コードを出さない。
- MQLは出力構文・シフト・履歴フィルタ・括弧対応・スナップショットを確認。MetaTrader/MetaEditorによるネイティブコンパイルは未実施（この環境にコンパイラがないため）。
- `strategies/`・`public/data/`・`docs/` の最終変更なし。候補登録、選定ログ追記、pushなし。

## チューナーレポート

- `reports/tune-virtual-strategies-2026-09-14T06-03-31-827Z.json` — 6 passed / 6 rejected。SHA256: `ee82a109bcb6881e1e1d3d8b335a2eae471fbf0ef64b911ad2db06fc1d250bb6`。
- `reports/tune-virtual-strategies-2026-09-14T06-03-32-877Z.json` — 4 passed / 8 rejected。SHA256: `5fb15299eae566df8cf42768a42d4be9d74136c08be232aea5a1d87b0679877b`。

実行コマンド:

```sh
node scripts/tune-virtual-strategies.mjs --entry-type parabolicSarState --deep-history --walk-forward
node scripts/tune-virtual-strategies.mjs --entry-type alligatorState --deep-history --walk-forward
```

## 選定結果（各12件）

Opt/Valの指標は `tradeCount / netProfitYen / PF`。頻度は件/日。日数は暦日で `(最終バー時刻−先頭バー時刻)/86400`。レポートの `dataWindow.optimizationBars` と `validationBars` を深履歴キャッシュに照合し、同じ70/30分割からOpt日数を算出した（`referenceSpanDays` はOpt日数ではない）。24件ともキャッシュの件数・参照日数・Val日数がレポートと一致。

`N/A` は選定値なしを意味する。不通過候補はレポートの `selectedCandidate` がnullなので、選定SL/TPや損益・頻度を捏造せずN/Aとする。下の参考比較表には未選定組合せを明記して全24件の頻度倍率を示す。

理由は全280組合せに含まれる棄却理由の集合（各組合せが全理由に該当する意味ではない）。O=optimization、V=validation、Q=四半期正数、overfit=既存過学習ゲート。四半期は選定対象にだけ実行する既存ロジックを維持。

### parabolicSarState

| pair | tf | status / 理由 | SL | TP | trailing | cooldown | Opt 件/円/PF | Val 件/円/PF | retention | Q 正/総 | Opt日 | Val日 | Opt件/日 | Val件/日 | 旧型Opt件 | 旧型Opt日 | 旧型Opt件/日 | Opt頻度倍率 |
|---|---|---|---:|---:|---:|---:|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| USDJPY | h1 | passed | 20 | 140 | なし | 3 | 952 / 230278 / 1.039864 | 330 / 201937 / 1.092044 | 0.876927 | 4/4 | 514.25 | 222.666667 | 1.85124 | 1.482036 | N/A | 514.25 | N/A | N/A |
| USDJPY | h4 | passed | 35 | 140 | なし | 0 | 587 / 259226 / 1.064828 | 143 / 111230 / 1.11076 | 0.429085 | 3/4 | 514.166667 | 220.666667 | 1.141653 | 0.648036 | 145 | 514.166667 | 0.28201 | 4.0483 |
| EURUSD | h1 | rejected / O≤0, V≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | N/A | 514.25 | N/A | N/A |
| EURUSD | h4 | passed | 20 | 160 | なし | 3 | 238 / 178400 / 1.101899 | 90 / 116172 / 1.180117 | 0.651188 | 3/4 | 514.166667 | 220.666667 | 0.462885 | 0.407855 | N/A | 514.166667 | N/A | N/A |
| GBPJPY | h1 | rejected / O≤0, V≤0, retention<0.35, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | N/A | 514.25 | N/A | N/A |
| GBPJPY | h4 | rejected / O≤0, O-PF<1, V≤0 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.166667 | 220.666667 | N/A | N/A | N/A | 514.166667 | N/A | N/A |
| EURJPY | h1 | rejected / O≤0, V≤0, retention<0.35, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | N/A | 514.25 | N/A | N/A |
| EURJPY | h4 | passed | 65 | 160 | なし | 0 | 352 / 20089 / 1.010413 | 102 / 15774 / 1.035081 | 0.785206 | 3/4 | 514.166667 | 220.666667 | 0.684603 | 0.462236 | N/A | 514.166667 | N/A | N/A |
| GBPUSD | h1 | rejected / O≤0, V≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | 540 | 514.25 | 1.050073 | N/A |
| GBPUSD | h4 | passed | 20 | 220 | なし | 3 | 256 / 138621 / 1.073815 | 96 / 126743 / 1.183361 | 0.914313 | 3/4 | 514.166667 | 220.666667 | 0.497893 | 0.435045 | 101 | 514.166667 | 0.196434 | 2.5347 |
| AUDJPY | h1 | rejected / V≤0, overfit, retention<0.35, O≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | N/A | 514.25 | N/A | N/A |
| AUDJPY | h4 | passed | 20 | 60 | なし | 3 | 384 / 275462 / 1.095945 | 144 / 114705 / 1.099247 | 0.41641 | 3/4 | 514.166667 | 220.666667 | 0.74684 | 0.652568 | 144 | 514.166667 | 0.280065 | 2.6667 |

### alligatorState

| pair | tf | status / 理由 | SL | TP | trailing | cooldown | Opt 件/円/PF | Val 件/円/PF | retention | Q 正/総 | Opt日 | Val日 | Opt件/日 | Val件/日 | 旧型Opt件 | 旧型Opt日 | 旧型Opt件/日 | Opt頻度倍率 |
|---|---|---|---:|---:|---:|---:|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| USDJPY | h1 | rejected / V≤0, overfit, retention<0.35, Q<3/4, O≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | N/A | 514.25 | N/A | N/A |
| USDJPY | h4 | rejected / V≤0, overfit, retention<0.35, O≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.166667 | 220.666667 | N/A | N/A | 31 | 514.166667 | 0.060292 | N/A |
| EURUSD | h1 | rejected / V≤0, overfit, retention<0.35, O≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | 69 | 514.25 | 0.134176 | N/A |
| EURUSD | h4 | passed | 50 | 220 | 25 | 3 | 318 / 70008 / 1.100178 | 124 / 25066 / 1.102314 | 0.358045 | 3/4 | 514.166667 | 220.666667 | 0.618476 | 0.561934 | N/A | 514.166667 | N/A | N/A |
| GBPJPY | h1 | rejected / O≤0, O-PF<1, V≤0 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | 128 | 514.25 | 0.248906 | N/A |
| GBPJPY | h4 | rejected / V≤0, overfit, retention<0.35, O≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.166667 | 220.666667 | N/A | N/A | N/A | 514.166667 | N/A | N/A |
| EURJPY | h1 | rejected / V≤0, overfit, retention<0.35, Q<3/4, O≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | N/A | 514.25 | N/A | N/A |
| EURJPY | h4 | rejected / V≤0, overfit, retention<0.35, O≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.166667 | 220.666667 | N/A | N/A | N/A | 514.166667 | N/A | N/A |
| GBPUSD | h1 | rejected / V≤0, overfit, retention<0.35, O≤0, O-PF<1 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | 514.25 | 222.666667 | N/A | N/A | 127 | 514.25 | 0.246962 | N/A |
| GBPUSD | h4 | passed | 65 | 200 | なし | 3 | 101 / 101922 / 1.161164 | 43 / 73203 / 1.370148 | 0.718226 | 3/4 | 514.166667 | 220.666667 | 0.196434 | 0.194864 | 32 | 514.166667 | 0.062237 | 3.1562 |
| AUDJPY | h1 | passed | 35 | 60 | なし | 3 | 583 / 199556 / 1.06246 | 236 / 101251 / 1.081334 | 0.507381 | 3/4 | 514.25 | 222.666667 | 1.13369 | 1.05988 | N/A | 514.25 | N/A | N/A |
| AUDJPY | h4 | passed | 110 | 220 | なし | 0 | 124 / 139391 / 1.273971 | 44 / 55577 / 1.346242 | 0.398713 | 3/4 | 514.166667 | 220.666667 | 0.241167 | 0.199396 | N/A | 514.166667 | N/A | N/A |

## 参考: 全24件の頻度比較（未選定組合せを含む）

旧型の一次参照は `evidence/tune-virtual-strategies-2026-08-18T22-32-23-991Z.selected.json`。null候補には取引数が保存されていないため、元の完全レポート `reports/tune-virtual-strategies-2026-08-18T22-32-23-991Z.json` を補助参照した。SHA256 `849789aa24977daa38e3001f11c0dff08083f19160dfef4f55bb9eef325aa681` が正典の `source.sha256` と一致することを確認済み。既存型は再チューニングしていない。

比較行の規則は新旧共通: selectedCandidateがあればその行、なければquarterlyChecked行（四半期不通過）、それもなければ最適化順位1の未選定行。新旧でSL/TPなども異なるため、倍率は各参考行の取引頻度比であり、state化だけの因果効果ではない。参考行を登録候補と解釈しない。

| 型 | pair | tf | 新型比較行 | 新 SL/TP/TR/CD | 新Opt件 | 新Opt日 | 新Opt件/日 | 新Val件 | 新Val日 | 新Val件/日 | 旧型比較行 | 旧Opt件 | 旧Opt日 | 旧Opt件/日 | Opt頻度倍率 | Val頻度倍率 |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| parabolicSarState | USDJPY | h1 | selected | 20/140/なし/3 | 952 | 514.25 | 1.85124 | 330 | 222.666667 | 1.482036 | quarterly-rejected rank 14 | 619 | 514.25 | 1.203695 | 1.538 | 1.5421 |
| parabolicSarState | USDJPY | h4 | selected | 35/140/なし/0 | 587 | 514.166667 | 1.141653 | 143 | 220.666667 | 0.648036 | selected | 145 | 514.166667 | 0.28201 | 4.0483 | 2.86 |
| parabolicSarState | EURUSD | h1 | unselected rank 1 | 110/100/25/3 | 866 | 514.25 | 1.684006 | 334 | 222.666667 | 1.5 | unselected rank 1 | 388 | 514.25 | 0.754497 | 2.232 | 2.0366 |
| parabolicSarState | EURUSD | h4 | selected | 20/160/なし/3 | 238 | 514.166667 | 0.462885 | 90 | 220.666667 | 0.407855 | unselected rank 1 | 124 | 514.166667 | 0.241167 | 1.9194 | 2.0455 |
| parabolicSarState | GBPJPY | h1 | unselected rank 1 | 110/140/なし/0 | 896 | 514.25 | 1.742343 | 350 | 222.666667 | 1.571856 | unselected rank 1 | 673 | 514.25 | 1.308702 | 1.3314 | 1.378 |
| parabolicSarState | GBPJPY | h4 | unselected rank 1 | 95/220/なし/3 | 225 | 514.166667 | 0.437601 | 75 | 220.666667 | 0.339879 | unselected rank 1 | 151 | 514.166667 | 0.293679 | 1.4901 | 1.6304 |
| parabolicSarState | EURJPY | h1 | unselected rank 1 | 110/60/なし/0 | 1127 | 514.25 | 2.191541 | 401 | 222.666667 | 1.800898 | unselected rank 1 | 514 | 514.25 | 0.999514 | 2.1926 | 2.1105 |
| parabolicSarState | EURJPY | h4 | selected | 65/160/なし/0 | 352 | 514.166667 | 0.684603 | 102 | 220.666667 | 0.462236 | quarterly-rejected rank 5 | 169 | 514.166667 | 0.328687 | 2.0828 | 1.7 |
| parabolicSarState | GBPUSD | h1 | unselected rank 1 | 110/120/なし/3 | 637 | 514.25 | 1.238697 | 274 | 222.666667 | 1.230539 | selected | 540 | 514.25 | 1.050073 | 1.1796 | 1.1861 |
| parabolicSarState | GBPUSD | h4 | selected | 20/220/なし/3 | 256 | 514.166667 | 0.497893 | 96 | 220.666667 | 0.435045 | selected | 101 | 514.166667 | 0.196434 | 2.5347 | 2.2326 |
| parabolicSarState | AUDJPY | h1 | unselected rank 1 | 50/100/なし/3 | 703 | 514.25 | 1.367039 | 291 | 222.666667 | 1.306886 | quarterly-rejected rank 4 | 415 | 514.25 | 0.807 | 1.694 | 1.6534 |
| parabolicSarState | AUDJPY | h4 | selected | 20/60/なし/3 | 384 | 514.166667 | 0.74684 | 144 | 220.666667 | 0.652568 | selected | 144 | 514.166667 | 0.280065 | 2.6667 | 2.6667 |
| alligatorState | USDJPY | h1 | quarterly-rejected rank 54 | 50/120/なし/3 | 475 | 514.25 | 0.923675 | 144 | 222.666667 | 0.646707 | unselected rank 1 | 105 | 514.25 | 0.204181 | 4.5238 | 2.7692 |
| alligatorState | USDJPY | h4 | unselected rank 1 | 35/120/なし/3 | 289 | 514.166667 | 0.562075 | 87 | 220.666667 | 0.39426 | selected | 31 | 514.166667 | 0.060292 | 9.3226 | 5.4375 |
| alligatorState | EURUSD | h1 | unselected rank 1 | 65/60/25/3 | 752 | 514.25 | 1.462324 | 290 | 222.666667 | 1.302395 | selected | 69 | 514.25 | 0.134176 | 10.8986 | 10.7407 |
| alligatorState | EURUSD | h4 | selected | 50/220/25/3 | 318 | 514.166667 | 0.618476 | 124 | 220.666667 | 0.561934 | unselected rank 1 | 28 | 514.166667 | 0.054457 | 11.3571 | 11.2727 |
| alligatorState | GBPJPY | h1 | unselected rank 1 | 110/140/なし/3 | 401 | 514.25 | 0.779776 | 135 | 222.666667 | 0.606287 | selected | 128 | 514.25 | 0.248906 | 3.1328 | 2.8125 |
| alligatorState | GBPJPY | h4 | unselected rank 1 | 80/120/なし/3 | 244 | 514.166667 | 0.474554 | 77 | 220.666667 | 0.348943 | unselected rank 1 | 36 | 514.166667 | 0.070016 | 6.7778 | 3.85 |
| alligatorState | EURJPY | h1 | quarterly-rejected rank 4 | 110/80/なし/3 | 439 | 514.25 | 0.85367 | 148 | 222.666667 | 0.664671 | unselected rank 1 | 96 | 514.25 | 0.18668 | 4.5729 | 4.2286 |
| alligatorState | EURJPY | h4 | unselected rank 1 | 65/160/なし/3 | 201 | 514.166667 | 0.390924 | 61 | 220.666667 | 0.276435 | unselected rank 1 | 30 | 514.166667 | 0.058347 | 6.7 | 6.7778 |
| alligatorState | GBPUSD | h1 | unselected rank 1 | 35/140/なし/3 | 358 | 514.25 | 0.696159 | 157 | 222.666667 | 0.70509 | selected | 127 | 514.25 | 0.246962 | 2.8189 | 3.0192 |
| alligatorState | GBPUSD | h4 | selected | 65/200/なし/3 | 101 | 514.166667 | 0.196434 | 43 | 220.666667 | 0.194864 | selected | 32 | 514.166667 | 0.062237 | 3.1562 | 2.3889 |
| alligatorState | AUDJPY | h1 | selected | 35/60/なし/3 | 583 | 514.25 | 1.13369 | 236 | 222.666667 | 1.05988 | unselected rank 1 | 105 | 514.25 | 0.204181 | 5.5524 | 7.6129 |
| alligatorState | AUDJPY | h4 | selected | 110/220/なし/0 | 124 | 514.166667 | 0.241167 | 44 | 220.666667 | 0.199396 | quarterly-rejected rank 2 | 33 | 514.166667 | 0.064182 | 3.7576 | 2.5882 |

## 未実施・制約

- MetaEditorネイティブコンパイル・実機EA発注は未実施。生成テキストの検証と、ブラウザ側のバックテスト検証まで。
- 不通過14件のselectedCandidate値、および正典でnullの旧型選定値は存在しない。選定結果表はN/Aとし、補助の完全レポートに基づく参考頻度比較を別表にした。
- レポートは指定どおりgitignore対象の`reports/`に保存し、コミット対象はこの結果表と実装・テスト・新規スナップショットのみ。

## 独立レビュー

- mode: JSON gate / scale: large（19ファイル、生成スナップショット6件を含む）。
- reviewer path: 内蔵サブエージェント2担当、外部CLIへのフォールバックなし。
- scope: コア評価・バックテスト・MQL、チューナー・登録/画面入力検証・関連テスト、結果表と元レポート。
- phase: arch `ok=true` → 分担diff 2件とも `ok=true` → cross-check `ok=true`。
- iterations: 1/5。指摘に対応してnullの実行時検証を厳密化し、反対シグナル決済の回帰テストとチューナーのcooldown伝播テストを追加。
- unresolved / unreviewed source scope: なし。MetaEditorネイティブコンパイルは上記の未実施事項。
