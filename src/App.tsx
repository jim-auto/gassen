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

  return (
    <main className="app-shell">
      <section className="hud">
        <div className="brand-block">
          <p className="eyebrow">gassen / MVP</p>
          <h1>合戦シミュレーション</h1>
        </div>

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
          <button className={stats.command === 'advance' ? 'active' : ''} onClick={() => sendCommand('advance')}>
            前進
          </button>
          <button className={stats.command === 'hold' ? 'active' : ''} onClick={() => sendCommand('hold')}>
            防衛
          </button>
          <button className={stats.command === 'charge' ? 'active' : ''} onClick={() => sendCommand('charge')}>
            突撃
          </button>
          <button
            className={stats.command === 'target_commander' ? 'active' : ''}
            onClick={() => sendCommand('target_commander')}
          >
            敵将
          </button>
          <button className={stats.command === 'rally' ? 'active' : ''} onClick={() => sendCommand('rally')}>
            鼓舞
          </button>
          <button className="ghost" onClick={() => sendCommand('reset')}>
            再戦
          </button>
        </div>

        <div className="formation-row" aria-label="formations">
          <button className={stats.formations.blue === 'line' ? 'active' : ''} onClick={() => sendFormation('line')}>
            横陣
          </button>
          <button className={stats.formations.blue === 'wedge' ? 'active' : ''} onClick={() => sendFormation('wedge')}>
            魚鱗
          </button>
          <button className={stats.formations.blue === 'crane' ? 'active' : ''} onClick={() => sendFormation('crane')}>
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
