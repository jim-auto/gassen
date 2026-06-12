import Phaser from 'phaser';
import {
  BattleCommand,
  BattleFormation,
  BattleIncident,
  BattleResult,
  BattleStats,
  COMMAND_EVENT,
  Faction,
  FORMATION_EVENT,
  STATS_EVENT,
  TIME_SCALE_EVENT,
  TimeScale,
} from './events';

type UnitKind = 'infantry' | 'spear' | 'cavalry' | 'commander';

interface BattleUnit {
  id: number;
  faction: Faction;
  kind: UnitKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  homeX: number;
  originY: number;
  morale: number;
  maxMorale: number;
  radius: number;
  speed: number;
  attack: number;
  mass: number;
  alive: boolean;
  routing: boolean;
  engaged: boolean;
  commandBuff: number;
  orderFocus: number;
  flankThreat: number;
  collapseShock: number;
}

interface FrontSegment {
  index: number;
  y: number;
  x: number;
  pressure: number;
  contacts: number;
  breakthrough?: Faction;
}

interface CommanderOrder {
  faction: Faction;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  power: number;
  kind: 'charge' | 'target';
}

interface UnitProfile {
  morale: number;
  radius: number;
  speed: number;
  attack: number;
  mass: number;
}

interface TacticalEvent extends BattleIncident {
  key: string;
  x: number;
  y: number;
  radius: number;
  until: number;
}

const WORLD_WIDTH = 1180;
const WORLD_HEIGHT = 660;
const LANE_TOP = 150;
const LANE_BOTTOM = 510;
const LANE_CENTER_Y = (LANE_TOP + LANE_BOTTOM) / 2;
const LEFT_BASE_X = 74;
const RIGHT_BASE_X = WORLD_WIDTH - LEFT_BASE_X;
const SOLDIERS_PER_SIDE = 50;
const FRONT_SEGMENTS = 9;
const SEGMENT_HEIGHT = (LANE_BOTTOM - LANE_TOP) / FRONT_SEGMENTS;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const factionDir = (faction: Faction) => (faction === 'blue' ? 1 : -1);
const enemyFaction = (faction: Faction): Faction => (faction === 'blue' ? 'red' : 'blue');

export class GassenScene extends Phaser.Scene {
  private graphics!: Phaser.GameObjects.Graphics;
  private units: BattleUnit[] = [];
  private nextId = 1;
  private elapsed = 0;
  private timeScale: TimeScale = 1;
  private lastStatsAt = 0;
  private frontLineX = WORLD_WIDTH / 2;
  private frontSegments: FrontSegment[] = [];
  private commanderOrders: CommanderOrder[] = [];
  private tacticalEvents: TacticalEvent[] = [];
  private incidentCooldowns: Record<string, number> = {};
  private playerCommand: BattleCommand = 'advance';
  private playerFormation: BattleFormation = 'line';
  private redFormation: BattleFormation = 'line';
  private playerCommandUntil = 0;
  private redChargeUntil = 0;
  private redRallyUntil = 0;
  private redTargetCommanderUntil = 0;
  private commanderAlive: Record<Faction, boolean> = { blue: true, red: true };
  private winner?: Faction;
  private battleResult?: BattleResult;
  private battleLog: string[] = [];
  private lastBreakthroughLog = '';
  private lastBreakthroughLogAt = -99;
  private removeCommandListener?: () => void;

  constructor() {
    super('GassenScene');
  }

  create() {
    this.graphics = this.add.graphics();
    this.resetBattle();

    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<BattleCommand>).detail;
      if (command === 'reset') {
        this.resetBattle();
        return;
      }

      this.playerCommand = command;
      const duration = command === 'charge' ? 7 : command === 'rally' ? 6.5 : 9999;
      this.playerCommandUntil = this.elapsed + duration;
      this.addLog(this.commandLabel(command));
    };

    const onFormation = (event: Event) => {
      const formation = (event as CustomEvent<BattleFormation>).detail;
      this.playerFormation = formation;
      this.addLog(`青軍 ${this.formationLabel(formation)}`);
    };

    const onTimeScale = (event: Event) => {
      const nextScale = (event as CustomEvent<TimeScale>).detail;
      this.timeScale = this.winner ? 0 : nextScale;
      this.emitStats();
    };

    window.addEventListener(COMMAND_EVENT, onCommand);
    window.addEventListener(FORMATION_EVENT, onFormation);
    window.addEventListener(TIME_SCALE_EVENT, onTimeScale);
    this.removeCommandListener = () => window.removeEventListener(COMMAND_EVENT, onCommand);
    const removeFormationListener = () => window.removeEventListener(FORMATION_EVENT, onFormation);
    const removeTimeScaleListener = () => window.removeEventListener(TIME_SCALE_EVENT, onTimeScale);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.removeCommandListener?.();
      removeFormationListener();
      removeTimeScaleListener();
    });
    this.events.once(Phaser.Scenes.Events.DESTROY, () => {
      this.removeCommandListener?.();
      removeFormationListener();
      removeTimeScaleListener();
    });
  }

  update(_: number, deltaMs: number) {
    const dt = this.timeScale === 0 ? 0 : Math.min((deltaMs / 1000) * this.timeScale, 1 / 12);
    if (dt === 0) {
      this.renderBattle();
      return;
    }

    this.elapsed += dt;

    if ((this.playerCommand === 'charge' || this.playerCommand === 'rally') && this.elapsed > this.playerCommandUntil) {
      this.playerCommand = 'advance';
    }

    this.updateRedAI();
    this.updateBattle(dt);
    this.renderBattle();

    if (this.elapsed - this.lastStatsAt > 0.12) {
      this.lastStatsAt = this.elapsed;
      this.emitStats();
    }
  }

  private resetBattle() {
    this.units = [];
    this.nextId = 1;
    this.elapsed = 0;
    this.timeScale = 1;
    this.lastStatsAt = 0;
    this.frontLineX = WORLD_WIDTH / 2;
    this.frontSegments = this.createFrontSegments();
    this.commanderOrders = [];
    this.tacticalEvents = [];
    this.incidentCooldowns = {};
    this.playerCommand = 'advance';
    this.playerFormation = 'line';
    this.redFormation = 'line';
    this.playerCommandUntil = 0;
    this.redChargeUntil = 0;
    this.redRallyUntil = 0;
    this.redTargetCommanderUntil = 0;
    this.commanderAlive = { blue: true, red: true };
    this.winner = undefined;
    this.battleResult = undefined;
    this.battleLog = ['開戦'];
    this.lastBreakthroughLog = '';
    this.lastBreakthroughLogAt = -99;

    this.spawnSide('blue');
    this.spawnSide('red');
    this.emitStats();
  }

  private spawnSide(faction: Faction) {
    const dir = factionDir(faction);
    const startX = faction === 'blue' ? 170 : WORLD_WIDTH - 170;
    const homeX = faction === 'blue' ? LEFT_BASE_X : RIGHT_BASE_X;
    const rows = 10;
    const cols = SOLDIERS_PER_SIDE / rows;
    const rowSpacing = 29;
    const colSpacing = 25;

    for (let col = 0; col < cols; col += 1) {
      for (let row = 0; row < rows; row += 1) {
        const kind = this.formationKind(row, col, rows);
        const profile = this.unitProfile(kind);
        const y = LANE_CENTER_Y - ((rows - 1) * rowSpacing) / 2 + row * rowSpacing;
        const x = startX - dir * col * colSpacing + this.seedJitter(row, col, faction) * 7;
        this.units.push({
          id: this.nextId++,
          faction,
          kind,
          x,
          y,
          vx: 0,
          vy: 0,
          homeX,
          originY: y,
          morale: profile.morale,
          maxMorale: profile.morale,
          radius: profile.radius,
          speed: profile.speed,
          attack: profile.attack,
          mass: profile.mass,
          alive: true,
          routing: false,
          engaged: false,
          commandBuff: 0,
          orderFocus: 0,
          flankThreat: 0,
          collapseShock: 0,
        });
      }
    }

    this.units.push({
      id: this.nextId++,
      faction,
      kind: 'commander',
      x: faction === 'blue' ? 105 : WORLD_WIDTH - 105,
      y: LANE_CENTER_Y,
      vx: 0,
      vy: 0,
      homeX,
      originY: LANE_CENTER_Y,
      morale: 180,
      maxMorale: 180,
      radius: 13,
      speed: 58,
      attack: 13,
      mass: 2.2,
      alive: true,
      routing: false,
      engaged: false,
      commandBuff: 0,
      orderFocus: 0,
      flankThreat: 0,
      collapseShock: 0,
    });
  }

  private formationKind(row: number, col: number, rows: number): UnitKind {
    if ((row === 0 || row === rows - 1) && col >= 1) return 'cavalry';
    if ((row + col) % 3 === 0) return 'spear';
    return 'infantry';
  }

  private unitProfile(kind: UnitKind): UnitProfile {
    switch (kind) {
      case 'spear':
        return { morale: 106, radius: 7.5, speed: 41, attack: 7.2, mass: 1.18 };
      case 'cavalry':
        return { morale: 92, radius: 8.2, speed: 70, attack: 7.8, mass: 0.96 };
      case 'commander':
        return { morale: 180, radius: 13, speed: 58, attack: 13, mass: 2.2 };
      case 'infantry':
      default:
        return { morale: 98, radius: 7, speed: 48, attack: 6.9, mass: 1.05 };
    }
  }

  private createFrontSegments(): FrontSegment[] {
    return Array.from({ length: FRONT_SEGMENTS }, (_, index) => ({
      index,
      y: LANE_TOP + SEGMENT_HEIGHT * (index + 0.5),
      x: WORLD_WIDTH / 2,
      pressure: 0,
      contacts: 0,
    }));
  }

  private seedJitter(row: number, col: number, faction: Faction) {
    const n = Math.sin((row + 1) * 12.9898 + (col + 1) * 78.233 + (faction === 'blue' ? 0 : 37.71));
    return n - Math.floor(n) - 0.5;
  }

  private updateRedAI() {
    if (this.winner) return;

    const redCommander = this.getCommander('red');
    const blueCommander = this.getCommander('blue');
    if (!redCommander || !blueCommander) return;

    const redActive = this.countActive('red');
    const blueActive = this.countActive('blue');
    const commanderGap = Math.abs(redCommander.x - blueCommander.x);
    const redStats = this.factionStats('red');
    const redMoraleLow = redStats.avgMorale < 48 || redStats.routing >= 6;
    const blueCommanderIsVulnerable = this.commanderIsolationScore('blue') > 0.68;

    if (redMoraleLow && this.elapsed > this.redRallyUntil) {
      this.redRallyUntil = this.elapsed + 5.2;
      this.addLog('赤軍 鼓舞');
    }

    if (blueCommanderIsVulnerable && redActive > 18 && this.elapsed > this.redTargetCommanderUntil) {
      this.redTargetCommanderUntil = this.elapsed + 6.2;
      this.addLog('赤軍 敵将狙い');
    }

    if (!this.commanderAlive.red || redActive < blueActive - 8) {
      this.setRedFormation('line');
    } else if (redActive > blueActive + 7 && this.elapsed > 13) {
      this.setRedFormation('crane');
    } else if (this.elapsed < this.redChargeUntil || commanderGap < 260) {
      this.setRedFormation('wedge');
    }

    if (redActive > 20 && (blueActive < redActive - 11 || commanderGap < 230 || this.elapsed > 42)) {
      const wasCharging = this.elapsed < this.redChargeUntil;
      this.redChargeUntil = Math.max(this.redChargeUntil, this.elapsed + 4.5);
      if (!wasCharging) {
        this.addLog('赤軍 突撃号令');
      }
    }
  }

  private setRedFormation(formation: BattleFormation) {
    if (this.redFormation === formation) return;
    this.redFormation = formation;
    this.addLog(`赤軍 ${this.formationLabel(formation)}`);
  }

  private commanderIsolationScore(faction: Faction) {
    const commander = this.getCommander(faction);
    if (!commander?.alive || commander.routing) return 0;

    const allies = this.activeUnits(faction).filter(
      (unit) => unit.kind !== 'commander' && Phaser.Math.Distance.Between(commander.x, commander.y, unit.x, unit.y) < 126,
    ).length;
    const enemies = this.activeUnits(enemyFaction(faction)).filter(
      (unit) => Phaser.Math.Distance.Between(commander.x, commander.y, unit.x, unit.y) < 162,
    ).length;
    return clamp((enemies - allies + 3) / 9, 0, 1);
  }

  private updateBattle(dt: number) {
    this.commanderOrders = [];
    this.units.forEach((unit) => {
      unit.engaged = false;
      unit.commandBuff = 0;
      unit.orderFocus = 0;
      unit.flankThreat = 0;
      unit.collapseShock = Math.max(0, unit.collapseShock - dt * 18);
    });

    this.applyCommanderAuras(dt);
    this.applyRally(dt);
    this.applyCommanderOrders(dt);
    this.moveUnits(dt);
    this.resolveContacts(dt);
    this.applyMoraleField(dt);
    this.updateFrontLine();
    this.detectTacticalEvents();
    this.resolveBreaks();
    this.resolveVictory();
  }

  private applyCommanderAuras(dt: number) {
    for (const commander of this.units) {
      if (commander.kind !== 'commander' || !commander.alive || commander.routing) continue;

      const command = commander.faction === 'blue' ? this.playerCommand : this.redCommand();
      const friendlyRadius = command === 'rally' ? 190 : 145;
      const enemyRadius = command === 'rally' ? 108 : 132;

      for (const unit of this.units) {
        if (!unit.alive || unit.routing || unit.kind === 'commander') continue;

        const distance = Phaser.Math.Distance.Between(commander.x, commander.y, unit.x, unit.y);
        if (unit.faction === commander.faction && distance < friendlyRadius) {
          const aura = 1 - distance / friendlyRadius;
          const isPlayer = commander.faction === 'blue';
          const rallyBoost = command === 'rally' ? (isPlayer ? 1.85 : 1.65) : 1;
          const playerBoost = isPlayer ? 1.12 : 1;
          unit.commandBuff = Math.max(unit.commandBuff, 0.18 + aura * (command === 'rally' ? 0.16 : 0.24) * playerBoost);
          unit.morale = Math.min(
            unit.maxMorale + 16,
            unit.morale + dt * (3.2 + aura * 5) * rallyBoost * playerBoost,
          );
          if (command === 'rally') {
            unit.collapseShock = Math.max(0, unit.collapseShock - dt * (10 + aura * 18));
            unit.flankThreat = Math.max(0, unit.flankThreat - dt * (0.7 + aura));
          }
        }

        if (unit.faction !== commander.faction && distance < enemyRadius) {
          const dread = 1 - distance / enemyRadius;
          unit.morale -= dt * (3.5 + dread * 8.5);
          unit.flankThreat = Math.max(unit.flankThreat, dread * 0.5);
        }
      }
    }
  }

  private applyRally(dt: number) {
    for (const commander of this.units) {
      if (commander.kind !== 'commander' || !commander.alive || commander.routing) continue;
      const command = commander.faction === 'blue' ? this.playerCommand : this.redCommand();
      if (command !== 'rally') continue;

      commander.morale = Math.min(commander.maxMorale + 20, commander.morale + dt * 8);

      for (const unit of this.units) {
        if (!unit.alive || unit.faction !== commander.faction || unit.kind === 'commander') continue;
        const distance = Phaser.Math.Distance.Between(commander.x, commander.y, unit.x, unit.y);
        if (distance > 220) continue;

        const aura = 1 - distance / 220;
        unit.collapseShock = Math.max(0, unit.collapseShock - dt * (20 + aura * 38));

        if (unit.routing) {
          unit.morale += dt * (28 + aura * 48);
          unit.vx *= 0.7;
          unit.vy += (commander.y - unit.y) * dt * 1.6;

          if (unit.morale > unit.maxMorale * 0.42 && distance < 170) {
            unit.routing = false;
            unit.engaged = false;
            unit.morale = Math.min(unit.maxMorale * 0.62, unit.morale);
            unit.originY = clamp((unit.originY + commander.y) / 2, LANE_TOP + 24, LANE_BOTTOM - 24);
            unit.vx = factionDir(unit.faction) * unit.speed * 0.35;
            this.addLog(`${unit.faction === 'blue' ? '青' : '赤'}軍 再集結`);
          }
        }
      }
    }
  }

  private applyCommanderOrders(dt: number) {
    for (const commander of this.units) {
      if (commander.kind !== 'commander' || !commander.alive || commander.routing) continue;

      const order = this.createCommanderOrder(commander);
      if (!order) continue;

      this.commanderOrders.push(order);

      for (const unit of this.units) {
        if (!unit.alive || unit.routing || unit.kind === 'commander') continue;

        const lineDistance = this.distanceToOrderLine(unit.x, unit.y, order);
        const targetDistance = Phaser.Math.Distance.Between(unit.x, unit.y, order.targetX, order.targetY);
        const withinOrderDepth =
          order.faction === 'blue'
            ? unit.x > commander.x - 170 && unit.x < order.targetX + 52
            : unit.x < commander.x + 170 && unit.x > order.targetX - 52;
        const corridor = order.kind === 'target' ? 84 : 98;
        const lineFocus = clamp(1 - lineDistance / corridor, 0, 1);
        const targetFocus = clamp(1 - targetDistance / 120, 0, 1);
        const focus = Math.max(lineFocus, targetFocus * 0.7) * order.power;

        if (unit.faction === order.faction && withinOrderDepth && focus > 0.08) {
          unit.orderFocus = Math.max(unit.orderFocus, focus);
          unit.commandBuff = Math.max(unit.commandBuff, 0.32 + focus * 0.42);
          unit.morale = Math.min(unit.maxMorale + 16, unit.morale + dt * (3.4 + focus * 6.8));
        }

        if (unit.faction !== order.faction && focus > 0.14 && targetDistance < 155) {
          unit.morale -= dt * (2.4 + focus * 8.8);
          unit.flankThreat = Math.max(unit.flankThreat, 0.25 + focus * 0.42);
        }
      }
    }
  }

  private createCommanderOrder(commander: BattleUnit): CommanderOrder | undefined {
    const command = commander.faction === 'blue' ? this.playerCommand : this.redCommand();
    if (command !== 'charge' && command !== 'target_commander') return undefined;

    const dir = factionDir(commander.faction);
    const target =
      command === 'target_commander'
        ? this.commanderTargetPoint(commander)
        : this.chargeTargetPoint(commander.faction);

    if (!target) return undefined;

    return {
      faction: commander.faction,
      startX: commander.x,
      startY: commander.y,
      targetX: target.x + dir * 42,
      targetY: target.y,
      power: command === 'charge' ? 1 : 0.82,
      kind: command === 'charge' ? 'charge' : 'target',
    };
  }

  private commanderTargetPoint(commander: BattleUnit) {
    const targetCommander = this.getCommander(enemyFaction(commander.faction));
    if (!targetCommander?.alive) return undefined;
    return { x: targetCommander.x, y: targetCommander.y };
  }

  private chargeTargetPoint(faction: Faction) {
    const dir = factionDir(faction);
    const candidate = this.frontSegments.reduce((best, segment) => {
      const localAdvantage = segment.pressure * dir;
      const contactScore = Math.min(segment.contacts, 12) / 18;
      const distanceFromCenter = Math.abs(segment.y - LANE_CENTER_Y) / (LANE_BOTTOM - LANE_TOP);
      const score = localAdvantage * 0.9 + contactScore * 0.55 - distanceFromCenter * 0.2;
      return score > best.score ? { segment, score } : best;
    }, { segment: this.frontSegments[Math.floor(FRONT_SEGMENTS / 2)], score: -999 });

    return {
      x: candidate.segment.x,
      y: candidate.segment.y,
    };
  }

  private distanceToOrderLine(x: number, y: number, order: CommanderOrder) {
    const dx = order.targetX - order.startX;
    const dy = order.targetY - order.startY;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq <= 0.001) return Phaser.Math.Distance.Between(x, y, order.startX, order.startY);

    const t = clamp(((x - order.startX) * dx + (y - order.startY) * dy) / lengthSq, 0, 1);
    const px = order.startX + dx * t;
    const py = order.startY + dy * t;
    return Phaser.Math.Distance.Between(x, y, px, py);
  }

  private orderForFaction(faction: Faction) {
    return this.commanderOrders.find((order) => order.faction === faction);
  }

  private formationForFaction(faction: Faction) {
    return faction === 'blue' ? this.playerFormation : this.redFormation;
  }

  private formationMove(unit: BattleUnit, formation: BattleFormation) {
    const spread = unit.originY - LANE_CENTER_Y;
    const wing = this.isWingUnit(unit);

    switch (formation) {
      case 'wedge':
        return {
          y: LANE_CENTER_Y + spread * 0.56,
          speedScale: wing ? 0.9 : 1.06,
          push: wing ? -0.02 : 0.18,
        };
      case 'crane':
        return {
          y: wing ? (spread < 0 ? LANE_TOP + 28 : LANE_BOTTOM - 28) : LANE_CENTER_Y + spread * 0.42,
          speedScale: wing ? 1.08 : 0.88,
          push: wing ? 0.16 : -0.04,
        };
      case 'line':
      default:
        return {
          y: unit.originY,
          speedScale: unit.kind === 'spear' ? 0.92 : 0.96,
          push: 0,
        };
    }
  }

  private isWingUnit(unit: BattleUnit) {
    return Math.abs(unit.originY - LANE_CENTER_Y) > 82;
  }

  private moveUnits(dt: number) {
    for (const unit of this.units) {
      if (!unit.alive) continue;

      if (unit.routing) {
        const dirHome = unit.faction === 'blue' ? -1 : 1;
        unit.vx = dirHome * (92 + unit.speed * 0.9);
        unit.vy += (unit.originY - unit.y) * dt * 1.8;
        unit.x += unit.vx * dt;
        unit.y += unit.vy * dt;
        unit.vy *= 0.86;
        unit.morale -= dt * 2.5;

        if ((unit.faction === 'blue' && unit.x < 8) || (unit.faction === 'red' && unit.x > WORLD_WIDTH - 8)) {
          unit.alive = false;
        }
        continue;
      }

      if (unit.kind === 'commander') {
        this.moveCommander(unit, dt);
        continue;
      }

      const command = unit.faction === 'blue' ? this.playerCommand : this.redCommand();
      const dir = factionDir(unit.faction);
      const nearestEnemy = this.findNearestEnemy(unit);
      const segment = this.segmentForUnit(unit);
      const order = this.orderForFaction(unit.faction);
      const formation = this.formationForFaction(unit.faction);
      let desiredVx = dir * unit.speed;
      let desiredY = unit.originY;

      const formationMove = this.formationMove(unit, formation);
      desiredY = formationMove.y;
      desiredVx *= formationMove.speedScale;
      desiredVx += dir * unit.speed * formationMove.push;

      if (unit.kind === 'cavalry') {
        const flankY = unit.originY < LANE_CENTER_Y ? LANE_TOP + 30 : LANE_BOTTOM - 30;
        const commitToFlank =
          formation === 'crane' || (command !== 'hold' && (!!order || (nearestEnemy && nearestEnemy.distance < 165)));
        desiredY = commitToFlank ? flankY : unit.originY;
        desiredVx += dir * unit.speed * (commitToFlank ? 0.38 : 0.12);
      }

      if (command === 'hold') {
        const holdX = unit.faction === 'blue' ? segment.x - 60 : segment.x + 60;
        desiredVx = (holdX - unit.x) * 0.58;
        unit.morale = Math.min(unit.maxMorale + 8, unit.morale + dt * 2.8);
      }

      if (command === 'charge') {
        desiredVx = dir * unit.speed * (1.06 + unit.orderFocus * 0.72);
        unit.morale -= dt * (1.1 - unit.orderFocus * 0.55);
      }

      if (segment.breakthrough === unit.faction) {
        desiredVx += dir * unit.speed * 0.55;
        desiredY += (segment.y - unit.y) * 0.22;
      }

      if (order && unit.orderFocus > 0.05) {
        desiredY += clamp(order.targetY - unit.y, -90, 90) * (0.22 + unit.orderFocus * 0.3);
        desiredVx += dir * unit.speed * unit.orderFocus * 0.34;
      }

      if (command === 'target_commander' && order && unit.orderFocus > 0.12) {
        const dx = order.targetX - unit.x;
        const dy = order.targetY - unit.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        desiredVx = (dx / distance) * unit.speed * (1.08 + unit.orderFocus * 0.48);
        desiredY = unit.y + (dy / distance) * 50;
      }

      if (nearestEnemy && nearestEnemy.distance < 74) {
        const contactBrake = unit.kind === 'cavalry' ? 0.2 : 0.08;
        const approachBrake = unit.kind === 'cavalry' ? 0.56 : 0.34;
        desiredVx *= nearestEnemy.distance < unit.radius + nearestEnemy.unit.radius + 15 ? contactBrake : approachBrake;
        desiredY = unit.y + clamp(nearestEnemy.dy, -36, 36) * -0.16;
      }

      const allyAvoidance = this.allyAvoidance(unit);
      desiredY += allyAvoidance.y;
      desiredVx += allyAvoidance.x;

      unit.vx += (desiredVx - unit.vx) * clamp(dt * 5.5, 0, 1);
      unit.vy += ((desiredY - unit.y) * 2.4 - unit.vy) * clamp(dt * 4.6, 0, 1);

      unit.x += unit.vx * dt;
      unit.y += unit.vy * dt;
      unit.y = clamp(unit.y, LANE_TOP + 18, LANE_BOTTOM - 18);
      unit.x = clamp(unit.x, LEFT_BASE_X - 20, RIGHT_BASE_X + 20);
    }
  }

  private moveCommander(unit: BattleUnit, dt: number) {
    const dir = factionDir(unit.faction);
    const command = unit.faction === 'blue' ? this.playerCommand : this.redCommand();
    const formation = this.formationForFaction(unit.faction);
    const targetCommander = this.getCommander(enemyFaction(unit.faction));
    const order = this.orderForFaction(unit.faction);
    const desiredOffset = command === 'charge' || command === 'target_commander' ? 86 : 138;
    let desiredX = unit.faction === 'blue' ? this.frontLineX - desiredOffset : this.frontLineX + desiredOffset;
    let desiredY = LANE_CENTER_Y;

    if (command === 'hold') {
      desiredX = unit.faction === 'blue' ? this.frontLineX - 172 : this.frontLineX + 172;
    }

    if (command === 'rally') {
      const rallyPoint = this.rallyPoint(unit.faction);
      desiredX = rallyPoint.x;
      desiredY = rallyPoint.y;
    }

    if (command === 'target_commander' && targetCommander?.alive) {
      desiredX = unit.x + clamp(targetCommander.x - unit.x, -160, 160);
      desiredY = unit.y + clamp(targetCommander.y - unit.y, -48, 48);
    }

    if (order && command === 'charge') {
      desiredX = order.targetX - dir * 96;
      desiredY += clamp(order.targetY - unit.y, -64, 64) * 0.7;
    }

    if (formation === 'wedge') {
      desiredX += dir * 26;
      desiredY = LANE_CENTER_Y;
    } else if (formation === 'crane') {
      desiredX -= dir * 18;
    }

    const nearestEnemy = this.findNearestEnemy(unit);
    if (nearestEnemy && nearestEnemy.distance < 48) {
      desiredX -= dir * 28;
    }

    unit.vx += ((desiredX - unit.x) * 0.72 - unit.vx) * clamp(dt * 3.2, 0, 1);
    unit.vy += ((desiredY - unit.y) * 2.1 - unit.vy) * clamp(dt * 3.4, 0, 1);
    unit.x += unit.vx * dt;
    unit.y += unit.vy * dt;
    unit.y = clamp(unit.y, LANE_TOP + 36, LANE_BOTTOM - 36);
  }

  private rallyPoint(faction: Faction) {
    const commander = this.getCommander(faction);
    const routing = this.units.filter((unit) => unit.faction === faction && unit.alive && unit.routing);
    if (routing.length > 0) {
      const x = routing.reduce((sum, unit) => sum + unit.x, 0) / routing.length;
      const y = routing.reduce((sum, unit) => sum + unit.y, 0) / routing.length;
      const minX = faction === 'blue' ? LEFT_BASE_X + 82 : this.frontLineX + 90;
      const maxX = faction === 'blue' ? this.frontLineX - 90 : RIGHT_BASE_X - 82;
      return {
        x: clamp(x, Math.min(minX, maxX), Math.max(minX, maxX)),
        y: clamp(y, LANE_TOP + 60, LANE_BOTTOM - 60),
      };
    }

    const dir = factionDir(faction);
    return {
      x: (commander?.x ?? this.frontLineX) - dir * 120,
      y: LANE_CENTER_Y,
    };
  }

  private allyAvoidance(unit: BattleUnit) {
    let avoidX = 0;
    let avoidY = 0;

    for (const other of this.units) {
      if (other === unit || !other.alive || other.faction !== unit.faction || other.routing) continue;
      const dx = unit.x - other.x;
      const dy = unit.y - other.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1 || d2 > 28 * 28) continue;
      const distance = Math.sqrt(d2);
      const force = (28 - distance) / 28;
      avoidX += (dx / distance) * force * 30;
      avoidY += (dy / distance) * force * 34;
    }

    return { x: clamp(avoidX, -28, 28), y: clamp(avoidY, -44, 44) };
  }

  private resolveContacts(dt: number) {
    for (let i = 0; i < this.units.length; i += 1) {
      const a = this.units[i];
      if (!a.alive || a.routing) continue;

      for (let j = i + 1; j < this.units.length; j += 1) {
        const b = this.units[j];
        if (!b.alive || b.routing || a.faction === b.faction) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(0.001, Math.hypot(dx, dy));
        const contactDistance = a.radius + b.radius + 7;
        if (distance > contactDistance) continue;

        a.engaged = true;
        b.engaged = true;

        const blue = a.faction === 'blue' ? a : b;
        const red = a.faction === 'red' ? a : b;
        const blueFlanking = this.isFlanking(blue, red);
        const redFlanking = this.isFlanking(red, blue);
        const bluePower = this.unitPower(blue) * this.kindAdvantage(blue, red, blueFlanking);
        const redPower = this.unitPower(red) * this.kindAdvantage(red, blue, redFlanking);
        const pressure = clamp((bluePower - redPower) * 0.75, -44, 44);
        const overlap = contactDistance - distance;
        const nx = dx / distance;
        const ny = dy / distance;

        a.x -= nx * overlap * 0.23;
        a.y -= ny * overlap * 0.18;
        b.x += nx * overlap * 0.23;
        b.y += ny * overlap * 0.18;

        blue.x += pressure * dt * 0.22;
        red.x += pressure * dt * 0.33;
        blue.vx += pressure * dt * 1.1;
        red.vx += pressure * dt * 1.1;

        blue.morale -= dt * redPower * 0.46 * (redFlanking ? 1.32 : 1);
        red.morale -= dt * bluePower * 0.46 * (blueFlanking ? 1.32 : 1);

        this.applyKindShock(blue, red, blueFlanking, dt);
        this.applyKindShock(red, blue, redFlanking, dt);

        if (pressure > 8) red.morale -= dt * pressure * 0.2;
        if (pressure < -8) blue.morale -= dt * -pressure * 0.2;

        if (Math.abs(dy) > 20 || blueFlanking || redFlanking) {
          a.flankThreat = Math.max(a.flankThreat, 0.34);
          b.flankThreat = Math.max(b.flankThreat, 0.34);
        }
      }
    }
  }

  private kindAdvantage(attacker: BattleUnit, defender: BattleUnit, flanking: boolean) {
    if (attacker.kind === 'spear' && defender.kind === 'cavalry') return 1.62;
    if (attacker.kind === 'cavalry' && defender.kind === 'spear') return flanking ? 0.92 : 0.52;
    if (attacker.kind === 'cavalry' && flanking) return 1.48;
    if (attacker.kind === 'infantry' && defender.kind === 'spear') return 1.08;
    if (attacker.kind === 'spear' && defender.kind === 'infantry') return 0.96;
    return 1;
  }

  private applyKindShock(attacker: BattleUnit, defender: BattleUnit, flanking: boolean, dt: number) {
    if (attacker.kind === 'cavalry' && flanking && defender.kind !== 'spear') {
      defender.morale -= dt * (7.8 + attacker.orderFocus * 7.5);
      defender.collapseShock += dt * (3.2 + attacker.orderFocus * 4.2);
      defender.flankThreat = Math.max(defender.flankThreat, 0.62);
    }

    if (attacker.kind === 'spear' && defender.kind === 'cavalry' && !flanking) {
      defender.morale -= dt * 12;
      defender.vx -= factionDir(defender.faction) * dt * 95;
      attacker.morale = Math.min(attacker.maxMorale + 8, attacker.morale + dt * 3.5);
    }
  }

  private isFlanking(attacker: BattleUnit, defender: BattleUnit) {
    const sideContact = Math.abs(attacker.y - defender.y) > 18;
    const passedLine = attacker.faction === 'blue' ? attacker.x > defender.x + 6 : attacker.x < defender.x - 6;
    return sideContact || passedLine;
  }

  private applyMoraleField(dt: number) {
    for (const unit of this.units) {
      if (!unit.alive || unit.routing) continue;

      const local = this.localCounts(unit);
      const segment = this.segmentForUnit(unit);
      const formation = this.formationForFaction(unit.faction);

      if (unit.engaged) {
        unit.morale -= dt * 1.1;
      } else {
        unit.morale = Math.min(unit.maxMorale, unit.morale + dt * 0.65);
      }

      if (local.enemies > local.allies + 1) {
        unit.morale -= dt * (local.enemies - local.allies) * 2.8;
      }

      if (local.routingAllies > 0) {
        unit.morale -= dt * local.routingAllies * 3.4;
      }

      if (unit.flankThreat > 0) {
        unit.morale -= dt * unit.flankThreat * 9;
      }

      if (segment.breakthrough && segment.breakthrough !== unit.faction) {
        unit.morale -= dt * 8.5;
        unit.flankThreat = Math.max(unit.flankThreat, 0.45);
      }

      const localPressure = segment.pressure * factionDir(unit.faction);
      if (localPressure < -0.25) {
        unit.morale -= dt * Math.abs(localPressure) * 5.2;
      }

      this.applyFormationMorale(unit, formation, localPressure, local.enemies, dt);

      if (!this.commanderAlive[unit.faction]) {
        unit.morale -= dt * (unit.kind === 'commander' ? 0 : 1.6);
      }

      if (unit.collapseShock > 0) {
        unit.morale -= dt * unit.collapseShock;
      }

      unit.morale = clamp(unit.morale, -50, unit.maxMorale + 16);
    }
  }

  private applyFormationMorale(
    unit: BattleUnit,
    formation: BattleFormation,
    localPressure: number,
    localEnemies: number,
    dt: number,
  ) {
    const wing = this.isWingUnit(unit);

    if (formation === 'line') {
      if (unit.kind === 'spear' || unit.engaged) {
        unit.morale = Math.min(unit.maxMorale + 10, unit.morale + dt * 1.8);
      }
      if (unit.flankThreat > 0) {
        unit.morale = Math.min(unit.maxMorale + 8, unit.morale + dt * unit.flankThreat * 2.8);
      }
    }

    if (formation === 'wedge') {
      if (!wing) {
        unit.morale = Math.min(unit.maxMorale + 14, unit.morale + dt * 2.4);
      } else if (localEnemies > 1 || localPressure < -0.2) {
        unit.morale -= dt * 1.9;
      }
    }

    if (formation === 'crane') {
      if (wing) {
        unit.morale = Math.min(unit.maxMorale + 12, unit.morale + dt * 1.6);
        if (unit.flankThreat > 0) {
          unit.morale = Math.min(unit.maxMorale + 12, unit.morale + dt * 1.4);
        }
      } else if (localPressure < -0.1) {
        unit.morale -= dt * 2.1;
      }
    }
  }

  private resolveBreaks() {
    for (const unit of this.units) {
      if (!unit.alive || unit.routing) continue;

      if (unit.kind === 'commander' && unit.morale <= 0) {
        this.defeatCommander(unit);
        continue;
      }

      if (unit.kind !== 'commander' && unit.morale <= 0) {
        unit.routing = true;
        unit.engaged = false;
        unit.vx = factionDir(unit.faction) * -110;
        unit.vy = (unit.originY - unit.y) * 0.9;
        this.shockNearby(unit, 62, 9);
      }
    }
  }

  private defeatCommander(commander: BattleUnit) {
    commander.alive = false;
    commander.routing = false;
    this.commanderAlive[commander.faction] = false;
    this.addLog(`${commander.faction === 'blue' ? '青' : '赤'}軍 武将討死`);

    for (const unit of this.units) {
      if (!unit.alive || unit.faction !== commander.faction || unit.kind === 'commander') continue;
      const distance = Phaser.Math.Distance.Between(commander.x, commander.y, unit.x, unit.y);
      const wave = distance < 280 ? 1 - distance / 280 : 0;
      unit.morale -= 24 + wave * 64;
      unit.collapseShock += 10 + wave * 38;
    }

    for (const enemy of this.units) {
      if (!enemy.alive || enemy.faction === commander.faction || enemy.routing) continue;
      const distance = Phaser.Math.Distance.Between(commander.x, commander.y, enemy.x, enemy.y);
      if (distance < 210) {
        enemy.morale = Math.min(enemy.maxMorale + 16, enemy.morale + 18 * (1 - distance / 210));
      }
    }
  }

  private shockNearby(source: BattleUnit, radius: number, shock: number) {
    for (const unit of this.units) {
      if (!unit.alive || unit.routing || unit.faction !== source.faction || unit === source) continue;
      const distance = Phaser.Math.Distance.Between(source.x, source.y, unit.x, unit.y);
      if (distance < radius) {
        unit.collapseShock += shock * (1 - distance / radius);
      }
    }
  }

  private resolveVictory() {
    if (this.winner) return;

    const blueActive = this.countActive('blue');
    const redActive = this.countActive('red');

    if (blueActive <= 6 || (!this.commanderAlive.blue && blueActive <= 18)) {
      this.finishBattle('red', this.commanderAlive.blue ? '青軍 戦線崩壊' : '青軍 武将討死');
      return;
    }

    if (redActive <= 8 || (!this.commanderAlive.red && redActive <= 20)) {
      this.finishBattle('blue', this.commanderAlive.red ? '赤軍 戦線崩壊' : '赤軍 武将討死');
    }
  }

  private finishBattle(winner: Faction, reason: string) {
    this.winner = winner;
    this.timeScale = 0;
    this.addLog(`${winner === 'blue' ? '青軍' : '赤軍'} 勝利`);

    const decisiveEvents = this.battleLog.filter((entry) =>
      entry.includes('突破') ||
      entry.includes('崩壊') ||
      entry.includes('孤立') ||
      entry.includes('包囲') ||
      entry.includes('討死') ||
      entry.includes('再集結'),
    );

    this.battleResult = {
      id: `${Math.round(this.elapsed * 1000)}-${winner}-${this.battleLog.length}`,
      winner,
      duration: this.elapsed,
      reason,
      blue: this.factionStats('blue'),
      red: this.factionStats('red'),
      formations: {
        blue: this.playerFormation,
        red: this.redFormation,
      },
      decisiveEvents: decisiveEvents.slice(-5),
      log: [...this.battleLog],
    };
    this.emitStats();
  }

  private updateFrontLine() {
    let total = 0;
    let weighted = 0;

    for (const segment of this.frontSegments) {
      const blueUnits = this.unitsInSegment('blue', segment.index);
      const redUnits = this.unitsInSegment('red', segment.index);
      const blueFront = this.frontUnitInSegment('blue', segment.index);
      const redFront = this.frontUnitInSegment('red', segment.index);
      const bluePower = blueUnits.reduce((sum, unit) => sum + this.unitPower(unit), 0);
      const redPower = redUnits.reduce((sum, unit) => sum + this.unitPower(unit), 0);
      const contacts = this.segmentContacts(segment.index);
      let target = segment.x;
      let breakthrough: Faction | undefined;

      if (blueFront && redFront) {
        target = (blueFront.x + redFront.x) / 2;
      } else if (blueFront && !redFront) {
        target = clamp(blueFront.x + 48, WORLD_WIDTH / 2, RIGHT_BASE_X);
      } else if (!blueFront && redFront) {
        target = clamp(redFront.x - 48, LEFT_BASE_X, WORLD_WIDTH / 2);
      } else {
        target = WORLD_WIDTH / 2;
      }

      const pressure = clamp((bluePower - redPower) / 42, -1, 1);
      const blueBreakthrough = blueFront && !redFront && blueFront.x > segment.x + 48 && blueFront.x > WORLD_WIDTH / 2 + 36;
      const redBreakthrough = redFront && !blueFront && redFront.x < segment.x - 48 && redFront.x < WORLD_WIDTH / 2 - 36;

      if (blueBreakthrough) breakthrough = 'blue';
      if (redBreakthrough) breakthrough = 'red';

      segment.x += (target - segment.x) * 0.18;
      segment.pressure += (pressure - segment.pressure) * 0.26;
      segment.contacts = contacts;
      segment.breakthrough = breakthrough;

      this.logBreakthrough(segment);

      const weight = contacts > 0 ? contacts + 2 : blueFront || redFront ? 1 : 0;
      total += segment.x * weight;
      weighted += weight;
    }

    if (weighted > 0) {
      this.frontLineX += (total / weighted - this.frontLineX) * 0.14;
    }
  }

  private detectTacticalEvents() {
    this.tacticalEvents = this.tacticalEvents.filter((event) => event.until > this.elapsed);
    if (this.elapsed < 4 || this.winner) return;

    this.detectCenterBreakthrough();
    this.detectWingCollapse('upper');
    this.detectWingCollapse('lower');
    this.detectCommanderIsolation('blue');
    this.detectCommanderIsolation('red');
    this.detectEncirclement('blue');
    this.detectEncirclement('red');
  }

  private detectCenterBreakthrough() {
    const centerSegments = this.frontSegments.slice(3, 6);
    const avgPressure = centerSegments.reduce((sum, segment) => sum + segment.pressure, 0) / centerSegments.length;
    const avgX = centerSegments.reduce((sum, segment) => sum + segment.x, 0) / centerSegments.length;
    const blueBreaks = centerSegments.filter((segment) => segment.breakthrough === 'blue').length;
    const redBreaks = centerSegments.filter((segment) => segment.breakthrough === 'red').length;

    if (avgPressure > 0.52 || blueBreaks >= 2 || avgX > WORLD_WIDTH / 2 + 78) {
      this.triggerIncident(
        {
          key: 'blue-center-breakthrough',
          kind: 'center_breakthrough',
          faction: 'blue',
          label: '青軍 中央突破',
          severity: 1,
          x: avgX,
          y: LANE_CENTER_Y,
          radius: 180,
        },
        9,
        () => this.applyMoralePulse('blue', avgX, LANE_CENTER_Y, 185, 21, 10),
      );
    }

    if (avgPressure < -0.52 || redBreaks >= 2 || avgX < WORLD_WIDTH / 2 - 78) {
      this.triggerIncident(
        {
          key: 'red-center-breakthrough',
          kind: 'center_breakthrough',
          faction: 'red',
          label: '赤軍 中央突破',
          severity: 1,
          x: avgX,
          y: LANE_CENTER_Y,
          radius: 180,
        },
        9,
        () => this.applyMoralePulse('red', avgX, LANE_CENTER_Y, 185, 21, 10),
      );
    }
  }

  private detectWingCollapse(zone: 'upper' | 'lower') {
    const indices = zone === 'upper' ? [0, 1, 2] : [6, 7, 8];
    const blueUnits = this.unitsInSegments('blue', indices);
    const redUnits = this.unitsInSegments('red', indices);
    const contacts = indices.reduce((sum, index) => sum + this.frontSegments[index].contacts, 0);
    const pressure = indices.reduce((sum, index) => sum + this.frontSegments[index].pressure, 0) / indices.length;
    const y = zone === 'upper' ? LANE_TOP + SEGMENT_HEIGHT * 1.5 : LANE_BOTTOM - SEGMENT_HEIGHT * 1.5;
    const label = zone === 'upper' ? '上翼' : '下翼';
    const x = indices.reduce((sum, index) => sum + this.frontSegments[index].x, 0) / indices.length;
    const engagedEnough = contacts > 0 || this.elapsed > 12;

    if (engagedEnough && redUnits.length <= 2 && blueUnits.length >= 5 && pressure > 0.26) {
      this.triggerIncident(
        {
          key: `red-${zone}-wing-collapse`,
          kind: 'wing_collapse',
          faction: 'red',
          label: `赤軍 ${label}崩壊`,
          severity: 0.9,
          x,
          y,
          radius: 150,
        },
        10,
        () => {
          this.applyMoraleHit('red', x, y, 170, 24, 15);
          this.applyMoralePulse('blue', x, y, 165, 8, 8);
        },
      );
    }

    if (engagedEnough && blueUnits.length <= 2 && redUnits.length >= 5 && pressure < -0.26) {
      this.triggerIncident(
        {
          key: `blue-${zone}-wing-collapse`,
          kind: 'wing_collapse',
          faction: 'blue',
          label: `青軍 ${label}崩壊`,
          severity: 0.9,
          x,
          y,
          radius: 150,
        },
        10,
        () => {
          this.applyMoraleHit('blue', x, y, 170, 24, 15);
          this.applyMoralePulse('red', x, y, 165, 8, 8);
        },
      );
    }
  }

  private detectCommanderIsolation(faction: Faction) {
    const commander = this.getCommander(faction);
    if (!commander?.alive || commander.routing) return;

    const allies = this.activeUnits(faction).filter(
      (unit) => unit.kind !== 'commander' && Phaser.Math.Distance.Between(commander.x, commander.y, unit.x, unit.y) < 112,
    ).length;
    const enemies = this.activeUnits(enemyFaction(faction)).filter(
      (unit) => Phaser.Math.Distance.Between(commander.x, commander.y, unit.x, unit.y) < 148,
    ).length;

    if (allies <= 2 && enemies >= 4) {
      const label = faction === 'blue' ? '青軍 武将孤立' : '赤軍 武将孤立';
      this.triggerIncident(
        {
          key: `${faction}-commander-isolated`,
          kind: 'commander_isolated',
          faction,
          label,
          severity: 1.1,
          x: commander.x,
          y: commander.y,
          radius: 170,
        },
        10,
        () => {
          commander.morale -= 18;
          this.applyMoraleHit(faction, commander.x, commander.y, 210, 18, 16);
          this.applyMoralePulse(enemyFaction(faction), commander.x, commander.y, 185, 5, 9);
        },
      );
    }
  }

  private detectEncirclement(attacker: Faction) {
    const victim = enemyFaction(attacker);
    if (this.countActive(victim) < 12) return;

    const dir = factionDir(attacker);
    const upperAttackers = this.unitsInSegments(attacker, [0, 1, 2]);
    const lowerAttackers = this.unitsInSegments(attacker, [6, 7, 8]);
    const victimCore = this.unitsInSegments(victim, [3, 4, 5]);
    if (victimCore.length < 5) return;

    const upperPassed = upperAttackers.filter((unit) => (unit.x - this.frontLineX) * dir > 52).length >= 2;
    const lowerPassed = lowerAttackers.filter((unit) => (unit.x - this.frontLineX) * dir > 52).length >= 2;
    const upperPressure = this.frontSegments.slice(0, 3).reduce((sum, segment) => sum + segment.pressure, 0) / 3;
    const lowerPressure = this.frontSegments.slice(6, 9).reduce((sum, segment) => sum + segment.pressure, 0) / 3;
    const wingPressure = upperPressure * dir > 0.22 && lowerPressure * dir > 0.22;

    if (upperPassed && lowerPassed && wingPressure) {
      const centerX = victimCore.reduce((sum, unit) => sum + unit.x, 0) / victimCore.length;
      this.triggerIncident(
        {
          key: `${attacker}-encirclement`,
          kind: 'encirclement',
          faction: attacker,
          label: `${attacker === 'blue' ? '青軍' : '赤軍'} 包囲完成`,
          severity: 1.2,
          x: centerX,
          y: LANE_CENTER_Y,
          radius: 245,
        },
        13,
        () => {
          this.applyMoraleHit(victim, centerX, LANE_CENTER_Y, 285, 26, 24);
          this.applyMoralePulse(attacker, centerX, LANE_CENTER_Y, 260, 6, 12);
        },
      );
    }
  }

  private triggerIncident(
    event: Omit<TacticalEvent, 'until'>,
    cooldown: number,
    effect: () => void,
  ) {
    const lastAt = this.incidentCooldowns[event.key] ?? -999;
    if (this.elapsed - lastAt < cooldown) return;

    this.incidentCooldowns[event.key] = this.elapsed;
    this.tacticalEvents.push({ ...event, until: this.elapsed + 4.2 });
    this.addLog(event.label);
    effect();
  }

  private applyMoralePulse(source: Faction, x: number, y: number, radius: number, enemyLoss: number, allyGain: number) {
    for (const unit of this.units) {
      if (!unit.alive || unit.routing) continue;
      const distance = Phaser.Math.Distance.Between(x, y, unit.x, unit.y);
      if (distance > radius) continue;

      const scale = 1 - distance / radius;
      if (unit.faction === source) {
        unit.morale = Math.min(unit.maxMorale + 18, unit.morale + allyGain * scale);
      } else {
        unit.morale -= enemyLoss * scale;
        unit.collapseShock += enemyLoss * 0.34 * scale;
        unit.flankThreat = Math.max(unit.flankThreat, 0.36 + scale * 0.34);
      }
    }
  }

  private applyMoraleHit(faction: Faction, x: number, y: number, radius: number, loss: number, shock: number) {
    for (const unit of this.units) {
      if (!unit.alive || unit.routing || unit.faction !== faction) continue;
      const distance = Phaser.Math.Distance.Between(x, y, unit.x, unit.y);
      if (distance > radius) continue;

      const scale = 1 - distance / radius;
      unit.morale -= loss * scale;
      unit.collapseShock += shock * scale;
      unit.flankThreat = Math.max(unit.flankThreat, 0.3 + scale * 0.4);
    }
  }

  private unitPower(unit: BattleUnit) {
    if (!unit.alive || unit.routing) return 0;

    const morale = clamp(unit.morale / unit.maxMorale, 0.12, 1.22);
    const charge = 1 + unit.orderFocus * 0.46;
    const commander = unit.kind === 'commander' ? 1.62 : 1;
    const formation = this.formationPower(unit);
    return unit.attack * unit.mass * morale * (1 + unit.commandBuff) * charge * commander * formation;
  }

  private formationPower(unit: BattleUnit) {
    if (unit.kind === 'commander') return 1;

    const formation = this.formationForFaction(unit.faction);
    const wing = this.isWingUnit(unit);

    if (formation === 'line') {
      if (unit.kind === 'spear') return 1.16;
      if (unit.kind === 'cavalry') return 0.9;
      return 1.05;
    }

    if (formation === 'wedge') {
      return wing ? 0.9 : 1.2;
    }

    if (formation === 'crane') {
      if (wing) return unit.kind === 'cavalry' ? 1.28 : 1.14;
      return 0.88;
    }

    return 1;
  }

  private localCounts(unit: BattleUnit) {
    let allies = 0;
    let enemies = 0;
    let routingAllies = 0;

    for (const other of this.units) {
      if (other === unit || !other.alive) continue;
      const distance = Phaser.Math.Distance.Between(unit.x, unit.y, other.x, other.y);
      if (distance > 64) continue;

      if (other.faction === unit.faction) {
        if (other.routing) routingAllies += 1;
        else allies += 1;
      } else if (!other.routing) {
        enemies += 1;
      }
    }

    return { allies, enemies, routingAllies };
  }

  private segmentForUnit(unit: BattleUnit) {
    return this.frontSegments[this.segmentIndex(unit.y)];
  }

  private segmentIndex(y: number) {
    return clamp(Math.floor((y - LANE_TOP) / SEGMENT_HEIGHT), 0, FRONT_SEGMENTS - 1);
  }

  private unitsInSegment(faction: Faction, segmentIndex: number) {
    return this.units.filter(
      (unit) =>
        unit.faction === faction &&
        unit.kind !== 'commander' &&
        unit.alive &&
        !unit.routing &&
        this.segmentIndex(unit.y) === segmentIndex,
    );
  }

  private unitsInSegments(faction: Faction, segmentIndices: number[]) {
    return this.units.filter(
      (unit) =>
        unit.faction === faction &&
        unit.kind !== 'commander' &&
        unit.alive &&
        !unit.routing &&
        segmentIndices.includes(this.segmentIndex(unit.y)),
    );
  }

  private activeUnits(faction: Faction) {
    return this.units.filter((unit) => unit.faction === faction && unit.alive && !unit.routing);
  }

  private frontUnitInSegment(faction: Faction, segmentIndex: number) {
    const units = this.unitsInSegment(faction, segmentIndex);
    if (units.length === 0) return undefined;

    return units.reduce((best, unit) => {
      if (faction === 'blue') return unit.x > best.x ? unit : best;
      return unit.x < best.x ? unit : best;
    }, units[0]);
  }

  private segmentContacts(segmentIndex: number) {
    let contacts = 0;

    for (const blue of this.unitsInSegment('blue', segmentIndex)) {
      for (const red of this.unitsInSegment('red', segmentIndex)) {
        if (Math.abs(blue.x - red.x) < 66 && Math.abs(blue.y - red.y) < 36) {
          contacts += 1;
        }
      }
    }

    return contacts;
  }

  private logBreakthrough(segment: FrontSegment) {
    if (!segment.breakthrough) return;

    const key = `${segment.breakthrough}-${segment.index}`;
    if (key === this.lastBreakthroughLog && this.elapsed - this.lastBreakthroughLogAt < 6) return;

    const sideLabel = segment.breakthrough === 'blue' ? '青軍' : '赤軍';
    const laneLabel = segment.index < 3 ? '上段' : segment.index > 5 ? '下段' : '中央';
    this.addLog(`${sideLabel} ${laneLabel}突破`);
    this.lastBreakthroughLog = key;
    this.lastBreakthroughLogAt = this.elapsed;
  }

  private findNearestEnemy(unit: BattleUnit) {
    let best: { unit: BattleUnit; distance: number; dx: number; dy: number } | undefined;

    for (const other of this.units) {
      if (!other.alive || other.routing || other.faction === unit.faction) continue;
      const dx = other.x - unit.x;
      const dy = other.y - unit.y;
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) {
        best = { unit: other, distance, dx, dy };
      }
    }

    return best;
  }

  private getCommander(faction: Faction) {
    return this.units.find((unit) => unit.faction === faction && unit.kind === 'commander');
  }

  private redCommand(): BattleCommand {
    if (this.elapsed < this.redRallyUntil) return 'rally';
    if (this.elapsed < this.redTargetCommanderUntil) return 'target_commander';
    if (this.elapsed < this.redChargeUntil) return 'charge';
    if (!this.commanderAlive.red) return 'hold';
    return 'advance';
  }

  private countActive(faction: Faction) {
    return this.units.filter((unit) => unit.faction === faction && unit.kind !== 'commander' && unit.alive && !unit.routing).length;
  }

  private frontMost(faction: Faction) {
    const soldiers = this.units.filter((unit) => unit.faction === faction && unit.alive && !unit.routing && unit.kind !== 'commander');
    if (soldiers.length === 0) return undefined;
    return soldiers.reduce((best, unit) => {
      if (faction === 'blue') return unit.x > best.x ? unit : best;
      return unit.x < best.x ? unit : best;
    }, soldiers[0]);
  }

  private addLog(message: string) {
    if (this.battleLog[this.battleLog.length - 1] === message) return;
    this.battleLog.push(message);
    if (this.battleLog.length > 8) {
      this.battleLog.shift();
    }
  }

  private commandLabel(command: BattleCommand) {
    switch (command) {
      case 'advance':
        return '青軍 前進';
      case 'hold':
        return '青軍 防衛';
      case 'charge':
        return '青軍 突撃号令';
      case 'target_commander':
        return '敵将狙い';
      case 'rally':
        return '青軍 鼓舞';
      default:
        return '命令';
    }
  }

  private formationLabel(formation: BattleFormation) {
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

  private renderBattle() {
    const g = this.graphics;
    g.clear();
    this.drawField(g);
    this.drawFormationGuides(g);
    this.drawCommanderAuras(g);
    this.drawCommanderOrders(g);
    this.drawFrontLine(g);
    this.drawTacticalEvents(g);

    const ordered = [...this.units].sort((a, b) => a.y - b.y);
    for (const unit of ordered) {
      this.drawUnit(g, unit);
    }
  }

  private drawField(g: Phaser.GameObjects.Graphics) {
    g.fillStyle(0x11130f, 1);
    g.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    g.fillStyle(0x262818, 1);
    g.fillRect(48, LANE_TOP, WORLD_WIDTH - 96, LANE_BOTTOM - LANE_TOP);

    g.lineStyle(1, 0x6f7244, 0.35);
    for (let y = LANE_TOP + 45; y < LANE_BOTTOM; y += 45) {
      g.lineBetween(58, y, WORLD_WIDTH - 58, y);
    }

    g.fillStyle(0x193f68, 0.28);
    g.fillRect(48, LANE_TOP, 120, LANE_BOTTOM - LANE_TOP);
    g.fillStyle(0x703126, 0.28);
    g.fillRect(WORLD_WIDTH - 168, LANE_TOP, 120, LANE_BOTTOM - LANE_TOP);

    g.lineStyle(3, 0x2e7ccf, 0.72);
    g.lineBetween(LEFT_BASE_X, LANE_TOP + 8, LEFT_BASE_X, LANE_BOTTOM - 8);
    g.lineStyle(3, 0xd85545, 0.72);
    g.lineBetween(RIGHT_BASE_X, LANE_TOP + 8, RIGHT_BASE_X, LANE_BOTTOM - 8);

    g.lineStyle(1, 0xf0c45a, 0.18);
    g.lineBetween(WORLD_WIDTH / 2, LANE_TOP + 10, WORLD_WIDTH / 2, LANE_BOTTOM - 10);
  }

  private drawFormationGuides(g: Phaser.GameObjects.Graphics) {
    this.drawFormationGuide(g, 'blue', this.playerFormation);
    this.drawFormationGuide(g, 'red', this.redFormation);
  }

  private drawFormationGuide(g: Phaser.GameObjects.Graphics, faction: Faction, formation: BattleFormation) {
    const dir = factionDir(faction);
    const color = faction === 'blue' ? 0x3e9bff : 0xf05c4d;
    const anchorX = this.frontLineX - dir * 95;
    const top = LANE_TOP + 30;
    const bottom = LANE_BOTTOM - 30;
    const center = LANE_CENTER_Y;

    g.lineStyle(2, color, 0.2);
    g.fillStyle(color, 0.035);

    if (formation === 'line') {
      g.lineBetween(anchorX, top, anchorX, bottom);
      g.lineBetween(anchorX - dir * 20, top + 18, anchorX - dir * 20, bottom - 18);
      return;
    }

    if (formation === 'wedge') {
      const pointX = anchorX + dir * 74;
      const baseX = anchorX - dir * 76;
      g.fillTriangle(pointX, center, baseX, top + 34, baseX, bottom - 34);
      g.lineBetween(pointX, center, baseX, top + 34);
      g.lineBetween(pointX, center, baseX, bottom - 34);
      g.lineBetween(baseX, top + 34, baseX, bottom - 34);
      return;
    }

    const wingX = anchorX + dir * 90;
    const centerX = anchorX - dir * 48;
    g.lineBetween(centerX, center, wingX, top);
    g.lineBetween(centerX, center, wingX, bottom);
    g.lineBetween(centerX, center, anchorX, center);
  }

  private drawCommanderAuras(g: Phaser.GameObjects.Graphics) {
    for (const commander of this.units) {
      if (commander.kind !== 'commander' || !commander.alive) continue;
      const command = commander.faction === 'blue' ? this.playerCommand : this.redCommand();
      const color = commander.faction === 'blue' ? 0x3e9bff : 0xf05c4d;
      const radius = command === 'rally' ? 190 : 145;
      const pulse = command === 'rally' ? 0.5 + Math.sin(this.elapsed * 10) * 0.5 : 0;
      g.lineStyle(command === 'rally' ? 3 : 1, command === 'rally' ? 0xf0c45a : color, command === 'rally' ? 0.34 + pulse * 0.18 : 0.2);
      g.strokeCircle(commander.x, commander.y, radius);
      g.fillStyle(command === 'rally' ? 0xf0c45a : color, command === 'rally' ? 0.07 : 0.045);
      g.fillCircle(commander.x, commander.y, radius);
    }
  }

  private drawCommanderOrders(g: Phaser.GameObjects.Graphics) {
    for (const order of this.commanderOrders) {
      const color = order.faction === 'blue' ? 0x59b7ff : 0xff695c;
      const pulse = 0.5 + Math.sin(this.elapsed * 9) * 0.5;
      const width = order.kind === 'charge' ? 16 : 10;
      const alpha = order.kind === 'charge' ? 0.18 + pulse * 0.08 : 0.12 + pulse * 0.05;
      const dir = factionDir(order.faction);

      g.lineStyle(width, color, alpha);
      g.lineBetween(order.startX, order.startY, order.targetX, order.targetY);
      g.lineStyle(2, 0xf4e6a3, 0.56);
      g.lineBetween(order.startX, order.startY, order.targetX, order.targetY);
      g.fillStyle(color, 0.72);
      g.fillTriangle(
        order.targetX + dir * 18,
        order.targetY,
        order.targetX - dir * 9,
        order.targetY - 11,
        order.targetX - dir * 9,
        order.targetY + 11,
      );
    }
  }

  private drawFrontLine(g: Phaser.GameObjects.Graphics) {
    const x = this.frontLineX;
    g.fillStyle(0xf0c45a, 0.05);
    g.fillRect(x - 22, LANE_TOP, 44, LANE_BOTTOM - LANE_TOP);

    for (const segment of this.frontSegments) {
      const top = LANE_TOP + segment.index * SEGMENT_HEIGHT;
      const color = segment.breakthrough === 'blue' ? 0x3e9bff : segment.breakthrough === 'red' ? 0xf05c4d : 0xf0c45a;
      const alpha = segment.breakthrough ? 0.18 : Math.abs(segment.pressure) * 0.08;
      g.fillStyle(color, alpha);
      g.fillRect(segment.x - 25, top, 50, SEGMENT_HEIGHT);

      if (segment.breakthrough) {
        const dir = factionDir(segment.breakthrough);
        g.fillStyle(color, 0.28);
        g.fillTriangle(
          segment.x + dir * 8,
          segment.y - 12,
          segment.x + dir * 42,
          segment.y,
          segment.x + dir * 8,
          segment.y + 12,
        );
      }
    }

    g.lineStyle(3, 0xf0c45a, 0.62);
    g.beginPath();
    for (let i = 0; i <= FRONT_SEGMENTS; i += 1) {
      const y = LANE_TOP + i * SEGMENT_HEIGHT;
      const lowerIndex = clamp(i - 1, 0, FRONT_SEGMENTS - 1);
      const upperIndex = clamp(i, 0, FRONT_SEGMENTS - 1);
      const segmentX = (this.frontSegments[lowerIndex].x + this.frontSegments[upperIndex].x) / 2;
      const wave = Math.sin(this.elapsed * 4 + i * 0.8) * 5;
      if (i === 0) g.moveTo(segmentX + wave, y);
      else g.lineTo(segmentX + wave, y);
    }
    g.strokePath();

    const pressure = this.frontPressure();
    const arrowX = x + pressure * 32;
    g.fillStyle(pressure >= 0 ? 0x3e9bff : 0xf05c4d, Math.abs(pressure) * 0.36);
    g.fillTriangle(arrowX, LANE_TOP - 12, arrowX + pressure * 26, LANE_TOP + 3, arrowX, LANE_TOP + 18);
  }

  private drawTacticalEvents(g: Phaser.GameObjects.Graphics) {
    for (const event of this.tacticalEvents) {
      const remaining = clamp((event.until - this.elapsed) / 4.2, 0, 1);
      const color = event.faction === 'blue' ? 0x59b7ff : 0xff695c;
      const pulse = 0.5 + Math.sin(this.elapsed * 12) * 0.5;
      const radius = event.radius * (1.04 - remaining * 0.12);
      const alpha = remaining * (0.13 + pulse * 0.05);

      g.fillStyle(color, alpha);
      g.fillCircle(event.x, event.y, radius);
      g.lineStyle(2, color, remaining * 0.45);
      g.strokeCircle(event.x, event.y, radius * 0.66);

      if (event.kind === 'encirclement') {
        g.lineStyle(3, color, remaining * 0.5);
        g.beginPath();
        g.arc(event.x, event.y, radius * 0.5, -1.1, 1.1, false);
        g.strokePath();
        g.beginPath();
        g.arc(event.x, event.y, radius * 0.5, 2.05, 4.25, false);
        g.strokePath();
      }

      if (event.kind === 'wing_collapse') {
        g.lineStyle(2, 0xf0c45a, remaining * 0.5);
        g.lineBetween(event.x - 22, event.y - 18, event.x + 22, event.y + 18);
        g.lineBetween(event.x + 22, event.y - 18, event.x - 22, event.y + 18);
      }
    }
  }

  private drawUnit(g: Phaser.GameObjects.Graphics, unit: BattleUnit) {
    if (!unit.alive) return;

    const moraleRatio = clamp(unit.morale / unit.maxMorale, 0, 1);
    const baseColor = this.unitColor(unit);
    const alpha = unit.routing ? 0.32 : 0.62 + moraleRatio * 0.36;
    const radius = unit.routing ? unit.radius * 0.7 : unit.radius;

    if (unit.engaged && !unit.routing) {
      g.fillStyle(0xf0c45a, 0.14);
      g.fillCircle(unit.x, unit.y, radius + 7);
    }

    if (unit.kind === 'commander') {
      this.drawCommander(g, unit, baseColor, moraleRatio);
      return;
    }

    g.fillStyle(baseColor, alpha);
    if (unit.kind === 'spear') {
      g.fillRect(unit.x - radius, unit.y - radius, radius * 2, radius * 2);
      g.lineStyle(1, 0xf5f0ce, alpha * 0.65);
      g.lineBetween(unit.x, unit.y - radius - 7, unit.x + factionDir(unit.faction) * 13, unit.y);
    } else if (unit.kind === 'cavalry') {
      const dir = factionDir(unit.faction);
      g.fillTriangle(unit.x + dir * radius * 1.35, unit.y, unit.x - dir * radius, unit.y - radius, unit.x - dir * radius, unit.y + radius);
      g.lineStyle(2, 0xf5f0ce, alpha * 0.52);
      g.lineBetween(unit.x - dir * radius * 0.5, unit.y, unit.x + dir * radius * 1.55, unit.y);
    } else {
      g.fillCircle(unit.x, unit.y, radius);
    }

    if (unit.orderFocus > 0.18 && !unit.routing) {
      g.lineStyle(1, 0xf0c45a, 0.34 + unit.orderFocus * 0.28);
      g.strokeCircle(unit.x, unit.y, radius + 5);
    }

    if (moraleRatio < 0.38 && !unit.routing) {
      g.lineStyle(1, 0xf4e5a0, 0.42);
      g.strokeCircle(unit.x, unit.y, radius + 3);
    }
  }

  private drawCommander(g: Phaser.GameObjects.Graphics, unit: BattleUnit, color: number, moraleRatio: number) {
    const dir = factionDir(unit.faction);
    g.fillStyle(0xf0c45a, 0.95);
    g.fillCircle(unit.x, unit.y, unit.radius + 5);
    g.fillStyle(color, 1);
    g.fillTriangle(unit.x, unit.y - 16, unit.x - 16, unit.y + 12, unit.x + 16, unit.y + 12);

    g.lineStyle(3, 0x16130b, 0.75);
    g.lineBetween(unit.x + dir * 10, unit.y - 18, unit.x + dir * 10, unit.y - 45);
    g.fillStyle(unit.faction === 'blue' ? 0x2e7ccf : 0xd85545, 0.96);
    g.fillRect(unit.x + dir * 10, unit.y - 45, dir * 28, 18);

    g.fillStyle(0x14140e, 0.82);
    g.fillRect(unit.x - 19, unit.y + 22, 38, 5);
    g.fillStyle(0xf0c45a, 0.86);
    g.fillRect(unit.x - 18, unit.y + 23, 36 * moraleRatio, 3);
  }

  private unitColor(unit: BattleUnit) {
    if (unit.routing) return 0x8c897e;
    if (unit.faction === 'blue') {
      if (unit.kind === 'spear') return 0x49b6a2;
      if (unit.kind === 'cavalry') return 0x8fd1ff;
      return 0x3584e4;
    }
    if (unit.kind === 'spear') return 0xf07d43;
    if (unit.kind === 'cavalry') return 0xffb15c;
    return 0xd84f45;
  }

  private emitStats() {
    const stats: BattleStats = {
      time: this.elapsed,
      timeScale: this.timeScale,
      command: this.playerCommand,
      formations: {
        blue: this.playerFormation,
        red: this.redFormation,
      },
      frontLineX: this.frontLineX,
      frontPressure: this.frontPressure(),
      breakthrough: this.currentBreakthrough(),
      orders: {
        blue: this.commanderOrders.some((order) => order.faction === 'blue'),
        red: this.commanderOrders.some((order) => order.faction === 'red'),
      },
      rallying: {
        blue: this.playerCommand === 'rally',
        red: this.redCommand() === 'rally',
      },
      incidents: this.tacticalEvents
        .filter((event) => event.until > this.elapsed)
        .map(({ kind, faction, label, severity }) => ({ kind, faction, label, severity })),
      blue: this.factionStats('blue'),
      red: this.factionStats('red'),
      log: [...this.battleLog],
      winner: this.winner,
      result: this.battleResult,
    };

    window.dispatchEvent(new CustomEvent<BattleStats>(STATS_EVENT, { detail: stats }));
  }

  private frontPressure() {
    if (this.frontSegments.length === 0) return 0;
    const sum = this.frontSegments.reduce((total, segment) => total + segment.pressure, 0);
    return clamp(sum / this.frontSegments.length, -1, 1);
  }

  private currentBreakthrough() {
    const blue = this.frontSegments.filter((segment) => segment.breakthrough === 'blue').length;
    const red = this.frontSegments.filter((segment) => segment.breakthrough === 'red').length;
    if (blue === 0 && red === 0) return undefined;
    return blue >= red ? 'blue' : 'red';
  }

  private factionStats(faction: Faction) {
    const soldiers = this.units.filter((unit) => unit.faction === faction && unit.kind !== 'commander');
    const present = soldiers.filter((unit) => unit.alive);
    const fighting = present.filter((unit) => !unit.routing);
    const avgMorale =
      fighting.length > 0
        ? fighting.reduce((total, unit) => total + clamp(unit.morale, 0, unit.maxMorale), 0) / fighting.length
        : 0;

    return {
      active: fighting.length,
      routing: present.length - fighting.length,
      avgMorale,
      commanderAlive: this.commanderAlive[faction],
      infantry: fighting.filter((unit) => unit.kind === 'infantry').length,
      spear: fighting.filter((unit) => unit.kind === 'spear').length,
      cavalry: fighting.filter((unit) => unit.kind === 'cavalry').length,
    };
  }
}
