# FXチャート分析 (fx-chart-analyzer)

FXのテクニカル分析・シグナル検出・確率ベースの価格予測・EA(MQL5/MQL4)生成・ブラウザ内バックテストができる完全静的なWebアプリ。

## 機能

- **チャート分析**: ローソク足+SMA/EMA/ボリンジャーバンド/一目均衡表、サブチャートにRSI・MACD。6通貨ペア(USDJPY/EURUSD/GBPJPY/EURJPY/AUDJPY/GBPUSD)×3時間足(H1/H4/D1)。
- **自動分析**: ゴールデン/デッドクロス、RSI過熱、MACDクロス、BBブレイク、一目の雲、サポレジ距離を検出し、重み付き総合スコアで「強い売り〜強い買い」5段階判定。
- **価格予測**: 3モデルのアンサンブル(シグナル投票/対数リターン回帰ドリフト/自己相関レジーム)。1/5/20本先の上昇確率とATRベースの予測レンジ(68%/95%)を表示。ウォークフォワードによる過去の方向的中率もそのまま表示します。
- **EAビルダー**: エントリー条件(MAクロス/RSI/BB/MACD)と決済ルール(SL/TP/トレーリング/反対シグナル)をフォームで組み、手元のヒストリカルデータでバックテスト(勝率/PF/最大DD/資産曲線)。戦略から**コンパイル可能なMQL5/MQL4のEAソース**を生成・ダウンロードできます。

## 開発

```bash
npm install
npm run dev        # 開発サーバー
npm test           # ユニットテスト (indicators/signals/predict/backtest/mql)
npm run build      # 本番ビルド (dist/)
```

## データ更新

```bash
npm run fetch:data   # Dukascopyから6ペア×h1/h4/d1 (各2000本) を取得し public/data/ に保存
```

GitHub Actions (`.github/workflows/update-data.yml`) が毎日 06:00 JST に自動実行し、差分があればコミット→デプロイします。

## デプロイ

Cloudflare Pages。`wrangler pages deploy dist --project-name=fx-chart-analyzer` または GitHub Actions 経由。

⚠️ wrangler はHEADのコミットメッセージをデプロイ名に使うため、日本語メッセージだと稀にAPIエラーになります。失敗時はASCIIの空コミットを積んで再デプロイしてください。

## 免責事項

本アプリは学習・研究目的のツールであり、投資助言ではありません。FXの価格を高精度で予測することは原理的に不可能です。表示される「予測」は過去データに基づく統計的な傾向の可視化にすぎず、将来の値動きを保証しません。生成されるEAの使用・取引判断は自己責任で行ってください。
