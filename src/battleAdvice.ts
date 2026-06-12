import { BattleCommand, BattleFormation, BattleStats } from './game/events';

export type AdviceUrgency = 'calm' | 'warn' | 'push';

export interface BattleAdvice {
  command?: BattleCommand;
  formation?: BattleFormation;
  headline: string;
  detail: string;
  urgency: AdviceUrgency;
  ctaLabel: string;
}

const RED_COLLAPSE_ACTIVE = 8;
const RED_COMMANDER_COLLAPSE_ACTIVE = 20;

export function redVictoryThreshold(commanderAlive: boolean) {
  return commanderAlive ? RED_COLLAPSE_ACTIVE : RED_COMMANDER_COLLAPSE_ACTIVE;
}

export function redCollapseProgress(active: number, commanderAlive: boolean) {
  const threshold = redVictoryThreshold(commanderAlive);
  return Math.max(0, Math.min(100, ((50 - active) / (50 - threshold)) * 100));
}

export function commandLabel(command: BattleCommand) {
  switch (command) {
    case 'advance':
      return '前進';
    case 'hold':
      return '防衛';
    case 'charge':
      return '突撃';
    case 'target_commander':
      return '敵将狙い';
    case 'rally':
      return '鼓舞';
    default:
      return '命令';
  }
}

export function getBattleAdvice(stats: BattleStats): BattleAdvice {
  if (stats.winner || stats.result) {
    return {
      headline: '合戦終了',
      detail: stats.winner === 'blue' ? '青軍の勝利です。再戦で次の一手を試せます。' : '赤軍に敗北。次は鼓舞のタイミングを意識しましょう。',
      urgency: 'calm',
      ctaLabel: '再戦',
      command: 'reset',
    };
  }

  const { blue, red } = stats;
  const redThreshold = redVictoryThreshold(red.commanderAlive);
  const redRemaining = Math.max(0, red.active - redThreshold);

  if (blue.routing >= 3 || blue.avgMorale < 45) {
    return {
      command: 'rally',
      headline: '今すぐ鼓舞',
      detail: `自軍の潰走 ${blue.routing} 人。士気を戻さないと一気に負けます。`,
      urgency: 'warn',
      ctaLabel: '鼓舞する',
    };
  }

  if (!blue.commanderAlive && blue.active <= 22) {
    return {
      command: 'rally',
      headline: '残兵を集める',
      detail: '武将を失いました。鼓舞で残りを戦線に戻しましょう。',
      urgency: 'warn',
      ctaLabel: '鼓舞する',
    };
  }

  if (stats.frontPressure < -0.22 && blue.avgMorale < 58) {
    return {
      command: 'hold',
      headline: '防衛して持ちこたえる',
      detail: '赤軍優勢です。前線を保ちながら士気を回復させましょう。',
      urgency: 'warn',
      ctaLabel: '防衛する',
    };
  }

  if (
    red.commanderAlive &&
    (stats.incidents.some((incident) => incident.kind === 'commander_isolated' && incident.faction === 'red') ||
      (stats.breakthrough === 'blue' && stats.frontPressure > 0.28))
  ) {
    return {
      command: 'target_commander',
      headline: '敵将を討て',
      detail: '赤軍武将が危険です。討ち取れば勝ちが近づきます。',
      urgency: 'push',
      ctaLabel: '敵将を狙う',
    };
  }

  if (
    stats.frontPressure > 0.16 ||
    stats.breakthrough === 'blue' ||
    stats.incidents.some((incident) => incident.faction === 'blue')
  ) {
    return {
      command: 'charge',
      headline: redRemaining <= 12 ? 'とどめの突撃' : '突撃のチャンス',
      detail:
        redRemaining <= 12
          ? `赤軍あと ${redRemaining} 人で崩壊。突撃で畳みかけましょう。`
          : '青軍が有利です。突撃で敵の士気を崩してください。',
      urgency: 'push',
      ctaLabel: '突撃する',
    };
  }

  if (stats.time < 10 && stats.formations.blue !== 'line') {
    return {
      command: 'advance',
      formation: 'line',
      headline: '横陣で前進',
      detail: '序盤は横陣が安定します。このまま前進して接敵しましょう。',
      urgency: 'calm',
      ctaLabel: '横陣で前進',
    };
  }

  if (stats.time < 10) {
    return {
      command: 'advance',
      formation: 'line',
      headline: '横陣のまま前進',
      detail: 'まずは前進で戦線を押し、青優勢が出たら突撃です。',
      urgency: 'calm',
      ctaLabel: '前進を続ける',
    };
  }

  if (stats.frontPressure < -0.1) {
    return {
      command: 'hold',
      headline: '防衛で様子を見る',
      detail: '少し不利です。防衛で士気を保ち、逆転の隙を待ちましょう。',
      urgency: 'calm',
      ctaLabel: '防衛する',
    };
  }

  if (blue.active > red.active + 6 && stats.formations.blue !== 'crane') {
    return {
      command: 'advance',
      formation: 'crane',
      headline: '鶴翼で包囲',
      detail: '数的有利です。鶴翼に変えて両翼から押しましょう。',
      urgency: 'push',
      ctaLabel: '鶴翼で前進',
    };
  }

  return {
    command: 'advance',
    headline: '前進を維持',
    detail: '戦線を押し続け、青優勢や突破が出たら突撃に切り替えましょう。',
    urgency: 'calm',
    ctaLabel: '前進を続ける',
  };
}
