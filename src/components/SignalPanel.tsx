import type { SignalAnalysis, SignalDirection } from '../lib/signals';

interface SignalPanelProps {
  analysis: SignalAnalysis;
}

const directionLabels: Record<SignalDirection, string> = {
  bullish: '買い',
  bearish: '売り',
  neutral: '中立',
};

const meterLabels = ['強い売り', '売り', '中立', '買い', '強い買い'];

export function SignalPanel({ analysis }: SignalPanelProps) {
  return (
    <section className="analysis-panel" aria-label="自動分析パネル">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">自動分析</p>
          <h2>シグナル判定</h2>
        </div>
        <div className={`rating-badge rating-${analysis.rating.id}`}>{analysis.rating.label}</div>
      </div>

      <div className="signal-meter" aria-label={`総合判定: ${analysis.rating.label}`}>
        {meterLabels.map((label, index) => (
          <div
            key={label}
            className={index === analysis.rating.level ? 'meter-step meter-step-active' : 'meter-step'}
          >
            <span />
            <small>{label}</small>
          </div>
        ))}
      </div>

      <div className="score-row">
        <span>総合スコア</span>
        <strong>{analysis.score > 0 ? '+' : ''}{analysis.score}</strong>
      </div>

      {analysis.signals.length === 0 ? (
        <p className="empty-copy">現在のバーで強い発火シグナルはありません。</p>
      ) : (
        <ul className="signal-list">
          {analysis.signals.map((signal) => (
            <li key={signal.id} className={`signal-item signal-${signal.direction}`}>
              <div>
                <strong>{signal.label}</strong>
                <p>{signal.detail}</p>
              </div>
              <span>
                {directionLabels[signal.direction]} {signal.weight > 0 ? '+' : ''}{signal.weight}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
