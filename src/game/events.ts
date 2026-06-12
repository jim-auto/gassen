export type Faction = 'blue' | 'red';

export type BattleCommand = 'advance' | 'hold' | 'charge' | 'target_commander' | 'rally' | 'reset';
export type BattleFormation = 'line' | 'wedge' | 'crane';
export type BattleIncidentKind = 'center_breakthrough' | 'wing_collapse' | 'commander_isolated' | 'encirclement';
export type TimeScale = 0 | 1 | 2;

export interface FactionStats {
  active: number;
  routing: number;
  avgMorale: number;
  commanderAlive: boolean;
  infantry: number;
  spear: number;
  cavalry: number;
}

export interface BattleIncident {
  kind: BattleIncidentKind;
  faction: Faction;
  label: string;
  severity: number;
}

export interface BattleResult {
  id: string;
  winner: Faction;
  duration: number;
  reason: string;
  blue: FactionStats;
  red: FactionStats;
  formations: Record<Faction, BattleFormation>;
  decisiveEvents: string[];
  log: string[];
}

export interface BattleStats {
  time: number;
  timeScale: TimeScale;
  command: BattleCommand;
  formations: Record<Faction, BattleFormation>;
  frontLineX: number;
  frontPressure: number;
  breakthrough?: Faction;
  orders: Record<Faction, boolean>;
  rallying: Record<Faction, boolean>;
  incidents: BattleIncident[];
  blue: FactionStats;
  red: FactionStats;
  log: string[];
  winner?: Faction;
  result?: BattleResult;
}

export const STATS_EVENT = 'gassen:stats';
export const COMMAND_EVENT = 'gassen:command';
export const FORMATION_EVENT = 'gassen:formation';
export const TIME_SCALE_EVENT = 'gassen:time-scale';
