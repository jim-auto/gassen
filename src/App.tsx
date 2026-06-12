import { useEffect, useMemo, useRef, useState } from 'react';
import Phaser from 'phaser';
import { GassenScene } from './game/GassenScene';
import {
  BattleCommand,
  BattleFormation,
  BattleResult,
  BattleStats,
  COMMAND_EVENT,
  FORMATION_EVENT,
  STATS_EVENT,
  TIME_SCALE_EVENT,
  TimeScale,
} from './game/events';
import {
  getBattleAdvice,
  redCollapseProgress,
  redVictoryThreshold,
} from './battleAdvice';

const HISTORY_KEY = 'gassen:battle-history';

interface SavedBattleResult extends BattleResult {
  savedAt: number;
}

const initialStats: BattleStats = {
  time: 0,
  timeScale: 1,
  command: 'advance',
  formations: { blue: 'line', red: 'line' },
  frontLineX: 590,
  frontPressure: 0,
  orders: { blue: false, red: false },
  rallying: { blue: false, red: false },
  incidents: [],
  blue: { active: 50, routing: 0, avgMorale: 100, commanderAlive: true, infantry: 27, spear: 15, cavalry: 8 },
  red: { active: 50, routing: 0, avgMorale: 100, commanderAlive: true, infantry: 27, spear: 15, cavalry: 8 },
  log: ['開戦'],
};

function sendCommand(command: BattleCommand) {
  window.dispatchEvent(new CustomEvent<BattleCommand>(COMMAND_EVENT, { detail: command }));
}

function sendFormation(formation: BattleFormation) {
  window.dispatchEvent(new CustomEvent<BattleFormation>(FORMATION_EVENT, { detail: formation }));
}

function sendTimeScale(timeScale: TimeScale) {
  window.dispatchEvent(new CustomEvent<TimeScale>(TIME_SCALE_EVENT, { detail: timeScale }));
}

function moralePct(value: number) {
  return Math.round(Math.max(0, Math.min(120, value)));
}

function formationLabel(formation: BattleFormation) {
  switch (formation) {
    case 'line':
      return '横陣';
    case 'wedge':
      return '魚鱗';
    case 'crane':
      return '鶴翼';
    default:
      return '陣形';
  }
}

function winnerLabel(winner: 'blue' | 'red') {
  return winner === 'blue' ? '青軍' : '赤軍';
}

function formatDuration(seconds: number) {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
}

function loadBattleHistory(): SavedBattleResult[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveBattleHistory(history: SavedBattleResult[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Ignore storage quota/private-mode failures; the current result still renders.
  }
}

export default function App() {
  const gameRef = useRef<HTMLDivElement | null>(null);
  const phaserRef = useRef<Phaser.Game | null>(null);
  const [stats, setStats] = useState<BattleStats>(initialStats);
  const [battleHistory, setBattleHistory] = useState<SavedBattleResult[]>(() => loadBattleHistory());
  const savedResultIdsRef = useRef<Set<string> | null>(null);

  if (savedResultIdsRef.current === null) {
    savedResultIdsRef.current = new Set(battleHistory.map((result) => result.id));
  }

  useEffect(() => {
    if (!gameRef.current || phaserRef.current) return;

    phaserRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      parent: gameRef.current,
      backgroundColor: '#11130f',
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: 1180,
        height: 660,
      },
      physics: {
        default: 'arcade',
      },
      scene: GassenScene,
    });

    return () => {
      phaserRef.current?.destroy(true);
      phaserRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onStats = (event: Event) => {
      setStats((event as CustomEvent<BattleStats>).detail);
    };

    window.addEventListener(STATS_EVENT, onStats);
    return () => window.removeEventListener(STATS_EVENT, onStats);
  }, []);

  useEffect(() => {
    const result = stats.result;
    if (!result || savedResultIdsRef.current?.has(result.id)) return;

    savedResultIdsRef.current?.add(result.id);
    setBattleHistory((current) => {
      const next = [{ ...result, savedAt: Date.now() }, ...current.filter((item) => item.id !== result.id)].slice(0, 6);
      saveBattleHistory(next);
      return next;
    });
  }, [stats.result]);

  const frontLabel = useMemo(() => {
    if (stats.breakthrough === 'blue') return '青軍 突破';
    if (stats.breakthrough === 'red') return '赤軍 突破';

    const centerOffset = Math.round(stats.frontLineX - 590);
    if (centerOffset > 18) return `青 +${centerOffset}`;
    if (centerOffset < -18) return `赤 +${Math.abs(centerOffset)}`;
    return '拮抗';
  }, [stats.breakthrough, stats.frontLineX]);

  const pressureLabel = useMemo(() => {
    if (stats.frontPressure > 0.18) return '青優勢';
    if (stats.frontPressure < -0.18) return '赤優勢';
    return '均衡';
  }, [stats.frontPressure]);

  const orderLabel = useMemo(() => {
    if (stats.rallying.blue) return '青鼓舞';
    if (stats.rallying.red) return '赤鼓舞';
    if (stats.orders.blue) return '青号令';
    if (stats.orders.red) return '赤号令';
    return '号令なし';
  }, [stats.orders.blue, stats.orders.red, stats.rallying.blue, stats.rallying.red]);

  const incidentLabel = stats.incidents[0]?.label ?? '戦局安定';
  const timeLabel = stats.timeScale === 0 ? '停止' : `${stats.timeScale}x`;
  const advice = useMemo(() => getBattleAdvice(stats), [stats]);

  const commandClass = (command: BattleCommand) => {
    const classes = [];
    if (stats.command === command) classes.push('active');
    if (advice.command === command && stats.command !== command && !stats.winner) classes.push('suggested');
    return classes.join(' ');
  };

  const formationClass = (formation: BattleFormation) => {
    const classes = [];
    if (stats.formations.blue === formation) classes.push('active');
    if (advice.formation === formation && stats.formations.blue !== formation && !stats.winner) classes.push('suggested');
    return classes.join(' ');
  };

  const applyAdvice = () => {
    if (!advice.command || advice.command === 'reset') {
      sendCommand('reset');
      return;
    }
    sendCommand(advice.command);
    if (advice.formation) sendFormation(advice.formation);
  };

  return (
    <main className="app-shell">
      <section className="hud">
        <div className="brand-block">
          <p className="eyebrow">gassen / MVP</p>
          <h1>合戦シミュレーション</h1>
        </div>

        <GuidePanel />

        <ActionAdvisor stats={stats} advice={advice} onApply={applyAdvice} />

        <div className="score-grid" aria-label="battle status">
          <FactionPanel
            label="青軍"
            side="blue"
            active={stats.blue.active}
            routing={stats.blue.routing}
            morale={moralePct(stats.blue.avgMorale)}
            commanderAlive={stats.blue.commanderAlive}
            infantry={stats.blue.infantry}
            spear={stats.blue.spear}
            cavalry={stats.blue.cavalry}
          />
          <FactionPanel
            label="赤軍"
            side="red"
            active={stats.red.active}
            routing={stats.red.routing}
            morale={moralePct(stats.red.avgMorale)}
            commanderAlive={stats.red.commanderAlive}
            infantry={stats.red.infantry}
            spear={stats.red.spear}
            cavalry={stats.red.cavalry}
          />
        </div>

        <div className="command-row" aria-label="commands">
          <button className={commandClass('advance')} onClick={() => sendCommand('advance')}>
            前進
          </button>
          <button className={commandClass('hold')} onClick={() => sendCommand('hold')}>
            防衛
          </button>
          <button className={commandClass('charge')} onClick={() => sendCommand('charge')}>
            突撃
          </button>
          <button className={commandClass('target_commander')} onClick={() => sendCommand('target_commander')}>
            敵将
          </button>
          <button className={commandClass('rally')} onClick={() => sendCommand('rally')}>
            鼓舞
          </button>
          <button className="ghost" onClick={() => sendCommand('reset')}>
            再戦
          </button>
        </div>

        <div className="formation-row" aria-label="formations">
          <button className={formationClass('line')} onClick={() => sendFormation('line')}>
            横陣
          </button>
          <button className={formationClass('wedge')} onClick={() => sendFormation('wedge')}>
            魚鱗
          </button>
          <button className={formationClass('crane')} onClick={() => sendFormation('crane')}>
            鶴翼
          </button>
        </div>

        <div className="time-row" aria-label="time controls">
          <button className={stats.timeScale === 0 ? 'active' : ''} onClick={() => sendTimeScale(0)}>
            停止
          </button>
          <button className={stats.timeScale === 1 ? 'active' : ''} onClick={() => sendTimeScale(1)}>
            1x
          </button>
          <button className={stats.timeScale === 2 ? 'active' : ''} onClick={() => sendTimeScale(2)}>
            2x
          </button>
        </div>

        <div className="battle-strip">
          <span>戦線</span>
          <strong>{frontLabel}</strong>
          <span>{incidentLabel}</span>
          <span>{pressureLabel}</span>
          <span>{orderLabel}</span>
          <span>{formationLabel(stats.formations.blue)}</span>
          <span>{timeLabel}</span>
          <span>{Math.floor(stats.time)}秒</span>
        </div>

        <div className="log-panel" aria-label="battle log">
          {stats.log.map((entry, index) => (
            <div key={`${entry}-${index}`}>{entry}</div>
          ))}
        </div>

        {stats.result && <ResultPanel result={stats.result} />}
        {battleHistory.length > 0 && <HistoryPanel history={battleHistory} />}
      </section>

      <section className="battle-stage">
        <div ref={gameRef} className="game-root" />
        {stats.winner && <div className={`victory-banner ${stats.winner}`}>{stats.winner === 'blue' ? '青軍勝利' : '赤軍勝利'}</div>}
      </section>
    </main>
  );
}

function ActionAdvisor({
  stats,
  advice,
  onApply,
}: {
  stats: BattleStats;
  advice: ReturnType<typeof getBattleAdvice>;
  onApply: () => void;
}) {
  const redThreshold = redVictoryThreshold(stats.red.commanderAlive);
  const collapseProgress = redCollapseProgress(stats.red.active, stats.red.commanderAlive);
  const redRemaining = Math.max(0, stats.red.active - redThreshold);

  return (
    <article className={`action-advisor ${advice.urgency}`} aria-label="next action">
      <header>
        <span>次の一手</span>
        {!stats.winner && (
          <span className="collapse-label">
            敵崩壊まで あと {redRemaining} 人
          </span>
        )}
      </header>

      {!stats.winner && (
        <div className="collapse-meter" aria-label="enemy collapse progress">
          <div style={{ width: `${collapseProgress}%` }} />
        </div>
      )}

      <strong>{advice.headline}</strong>
      <p>{advice.detail}</p>

      {advice.command && (
        <button className="advisor-cta" onClick={onApply}>
          {advice.ctaLabel}
        </button>
      )}
    </article>
  );
}

function GuidePanel() {
  return (
    <details className="guide-panel">
      <summary>勝ち方ガイド</summary>
      <div className="guide-body">
        <p className="guide-lead">HPではなく<strong>士気</strong>を崩して、敵を潰走させる合戦です。上の「次の一手」ボタンに従うだけでも勝てます。</p>

        <section>
          <h2>勝ち条件</h2>
          <ul>
            <li>赤軍の戦闘中兵士が <strong>8人以下</strong></li>
            <li>赤軍武将を討ち、残兵が <strong>20人以下</strong></li>
          </ul>
        </section>

        <section>
          <h2>おすすめ手順</h2>
          <ol>
            <li>横陣 + 前進で接敵</li>
            <li>「青優勢」「中央突破」が出たら突撃</li>
            <li>潰走が増えたら鼓舞</li>
            <li>敵将が前に出たら敵将狙い</li>
          </ol>
        </section>

        <section>
          <h2>号令</h2>
          <dl>
            <div>
              <dt>前進</dt>
              <dd>標準。前線を押す</dd>
            </div>
            <div>
              <dt>防衛</dt>
              <dd>前線維持。士気回復</dd>
            </div>
            <div>
              <dt>突撃</dt>
              <dd>約6秒。有利なときに一気に押す</dd>
            </div>
            <div>
              <dt>敵将</dt>
              <dd>敵武将を狙う</dd>
            </div>
            <div>
              <dt>鼓舞</dt>
              <dd>約5秒。潰走兵を呼び戻す</dd>
            </div>
          </dl>
        </section>

        <section>
          <h2>陣形・相性</h2>
          <ul>
            <li>横陣 … 安定。槍が強い</li>
            <li>魚鱗 … 中央突破向き</li>
            <li>鶴翼 … 翼・包囲向き</li>
            <li>槍 → 騎、騎 → 側面・歩</li>
          </ul>
        </section>

        <p className="guide-note">上部の「士気」「潰走」が勝敗の目安です。</p>
      </div>
    </details>
  );
}

function ResultPanel({ result }: { result: BattleResult }) {
  const blueLoss = 50 - result.blue.active;
  const redLoss = 50 - result.red.active;

  return (
    <article className={`result-panel ${result.winner}`}>
      <header>
        <span>戦果</span>
        <strong>{winnerLabel(result.winner)}勝利</strong>
      </header>
      <div className="result-grid">
        <span>時間 {formatDuration(result.duration)}</span>
        <span>{result.reason}</span>
        <span>青損耗 {blueLoss}</span>
        <span>赤損耗 {redLoss}</span>
      </div>
      {result.decisiveEvents.length > 0 && (
        <div className="result-events">
          {result.decisiveEvents.map((event, index) => (
            <span key={`${event}-${index}`}>{event}</span>
          ))}
        </div>
      )}
    </article>
  );
}

function HistoryPanel({ history }: { history: SavedBattleResult[] }) {
  return (
    <article className="history-panel">
      <header>戦歴</header>
      {history.map((result) => (
        <div className="history-row" key={result.id}>
          <strong>{winnerLabel(result.winner)}</strong>
          <span>{formatDuration(result.duration)}</span>
          <span>{result.reason}</span>
        </div>
      ))}
    </article>
  );
}

interface FactionPanelProps {
  label: string;
  side: 'blue' | 'red';
  active: number;
  routing: number;
  morale: number;
  commanderAlive: boolean;
  infantry: number;
  spear: number;
  cavalry: number;
}

function FactionPanel({ label, side, active, routing, morale, commanderAlive, infantry, spear, cavalry }: FactionPanelProps) {
  return (
    <article className={`faction-panel ${side}`}>
      <header>
        <span>{label}</span>
        <strong>{active}</strong>
      </header>
      <div className="meter" aria-label={`${label} morale`}>
        <div style={{ width: `${Math.min(100, morale)}%` }} />
      </div>
      <footer>
        <span>士気 {morale}</span>
        <span>潰走 {routing}</span>
        <span>{commanderAlive ? '武将健在' : '武将討死'}</span>
      </footer>
      <div className="unit-counts">
        <span>歩 {infantry}</span>
        <span>槍 {spear}</span>
        <span>騎 {cavalry}</span>
      </div>
    </article>
  );
}
