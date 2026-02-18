import { DateTime } from 'luxon';
import { canonicalRooms, labelColumns } from '../constants';
import type {
  AssignmentInputRow,
  LabelCountKey,
  NurseSummaryRow,
  RoomAssignmentRow,
} from '../types';
import { formatClock } from './time';

interface NurseCapacity {
  nurseId: number;
  capacity: number;
}

interface NurseState {
  nurseId: number;
  remaining: number;
  nAssigned: number;
  loadSum: number;
  assignedGroups: Set<string>;
  hasBfi: boolean;
  hasCs: boolean;
}

interface DerivedRoom extends AssignmentInputRow {
  groupKey: string | null;
  workload: number;
  randKey: number;
  wEffective: number;
}

export interface AssignmentResult {
  perNurse: NurseSummaryRow[];
  perRoom: RoomAssignmentRow[];
}

const PEN_BFI_REPEAT = 50;
const PEN_CS_REPEAT = 75;

export function roomGroupKey(room?: string | null): string | null {
  if (!room) return null;
  const prefixes = ['8', '10', '14', '16', '18', '20', '32'];
  for (const prefix of prefixes) {
    if (room.startsWith(`${prefix}-`)) {
      return prefix;
    }
  }
  return room;
}

function computeCapacities(nRooms: number, nNurses: number): NurseCapacity[] {
  const base = Math.floor(nRooms / nNurses);
  const remainder = nRooms % nNurses;
  return Array.from({ length: nNurses }, (_, idx) => ({
    nurseId: idx + 1,
    capacity: idx < remainder ? base + 1 : base,
  }));
}

function roomWorkload(row: AssignmentInputRow): number {
  const base = 1;
  let weight = base;
  if (row.discharge === 'Y') weight -= 0.25;
  if (row.baby_in_scn === 'Y') weight -= 0.25;
  if (row.gyn === 'Y') weight -= 0.15;
  if (row.bfi === 'Y') weight += 0.4;
  if (row.cs === 'Y') weight += 0.55;
  if (row.vag === 'Y') weight += 0.2;
  return Math.max(weight, 0.2);
}

type SortDirection = 'oldest' | 'newest';

function getAgePriority(row: Pick<AssignmentInputRow, 'under_24' | 'over_24'>): number {
  if (row.under_24 === 'Y') return 0;
  if (row.over_24 === 'Y') return 1;
  return 2;
}

function compareByAgeThenTime(a: DerivedRoom, b: DerivedRoom, direction: SortDirection = 'oldest'): number {
  const ageDiff = getAgePriority(a) - getAgePriority(b);
  if (ageDiff !== 0) return ageDiff;
  const timeDiff = a.timeParsed.toMillis() - b.timeParsed.toMillis();
  if (timeDiff !== 0) {
    return direction === 'oldest' ? timeDiff : -timeDiff;
  }
  return a.room.localeCompare(b.room);
}

function sortByAgeThenTime(data: DerivedRoom[], direction: SortDirection = 'oldest'): DerivedRoom[] {
  return [...data].sort((a, b) => compareByAgeThenTime(a, b, direction));
}

function stablePseudoRandomKey(room: string, timeParsed: DateTime): number {
  const stamp = `${room}|${timeParsed.toFormat('yyyy-MM-dd HH:mm')}`;
  let acc = 0;
  for (let i = 0; i < stamp.length; i += 1) {
    const charCode = stamp.charCodeAt(i);
    acc += ((charCode * ((i + 1) % 97 + 1)) % 104_729);
  }
  return acc;
}

function makeEffectiveLoad(timeParsed: DateTime, workload: number): number {
  const minutes = timeParsed.hour * 60 + timeParsed.minute;
  return (1 + minutes / (24 * 60)) * workload;
}

function buildInitialState(capacities: NurseCapacity[]): NurseState[] {
  return capacities.map(({ nurseId, capacity }) => ({
    nurseId,
    remaining: capacity,
    nAssigned: 0,
    loadSum: 0,
    assignedGroups: new Set<string>(),
    hasBfi: false,
    hasCs: false,
  }));
}

function pickNurse(
  room: DerivedRoom,
  state: NurseState[],
  capacities: NurseCapacity[],
  capacityMap: Map<number, number>,
): number {
  const candidates = state.filter((nurse) => nurse.remaining > 0);
  if (candidates.length === 0) {
    throw new Error('No feasible nurse candidates: capacities exhausted');
  }

  const totalCapacity = capacities.reduce((sum, cap) => sum + cap.capacity, 0);
  const assignedSoFar = state.reduce((sum, nurse) => sum + nurse.nAssigned, 0);
  const totalLoad = state.reduce((sum, nurse) => sum + nurse.loadSum, 0);
  const meanLoadTarget = (totalLoad + room.wEffective) / state.length;

  const scored = candidates
    .map((nurse) => {
      const projN = nurse.nAssigned + 1;
      const projLoad = nurse.loadSum + room.wEffective;
      const nurseCapacity = capacityMap.get(nurse.nurseId) ?? 0;
      const capacityShare = nurseCapacity > 0 ? nurseCapacity / totalCapacity : 1 / state.length;
      const projTotalAssigned = assignedSoFar + 1;
      const projectedTarget = capacityShare * projTotalAssigned;
      const baseScore = (projN - projectedTarget) ** 2 + (projLoad - meanLoadTarget) ** 2;
      const hasGroup = room.groupKey ? nurse.assignedGroups.has(room.groupKey) : false;
      const groupScore = hasGroup ? baseScore - 1e-3 : baseScore;
      const repeatPenalty =
        (room.bfi === 'Y' && nurse.hasBfi ? PEN_BFI_REPEAT : 0) +
        (room.cs === 'Y' && nurse.hasCs ? PEN_CS_REPEAT : 0);
      return {
        nurseId: nurse.nurseId,
        score: groupScore + repeatPenalty,
      };
    })
    .sort((a, b) => a.score - b.score || a.nurseId - b.nurseId);

  return scored[0].nurseId;
}

function updateNurseState(nurseId: number, room: DerivedRoom, state: NurseState[]): void {
  const nurse = state.find((n) => n.nurseId === nurseId);
  if (!nurse) return;
  nurse.remaining = Math.max(0, nurse.remaining - 1);
  nurse.nAssigned += 1;
  nurse.loadSum += room.wEffective;
  if (room.groupKey) {
    nurse.assignedGroups.add(room.groupKey);
  }
  if (room.bfi === 'Y') nurse.hasBfi = true;
  if (room.cs === 'Y') nurse.hasCs = true;
}

export function buildRoomLabel(row: RoomAssignmentRow, tz: string): string {
  const parts: string[] = [];
  if (row.over_24 === 'Y') parts.push('over24');
  if (row.under_24 === 'Y') parts.push('under24');
  if (row.cs === 'Y') parts.push('cs');
  if (row.vag === 'Y') parts.push('vag');
  if (row.bfi === 'Y') parts.push('bfi');
  if (row.discharge === 'Y') parts.push('dc');
  if (row.gyn === 'Y') parts.push('gyn');
  const suffix = parts.length ? ` ${parts.join(' ')}` : '';
  return `${row.room} (${formatClock(row.time, tz)})${suffix}`;
}

function denseRankOldest(rooms: DerivedRoom[]): Map<string, number> {
  const ranked = [...rooms].sort((a, b) => a.timeParsed.toMillis() - b.timeParsed.toMillis() || a.room.localeCompare(b.room));
  const ranks = new Map<string, number>();
  let currentRank = 0;
  let lastMillis: number | null = null;
  for (const room of ranked) {
    const millis = room.timeParsed.toMillis();
    if (lastMillis === null || millis !== lastMillis) {
      currentRank += 1;
      lastMillis = millis;
    }
    ranks.set(room.room, currentRank);
  }
  return ranks;
}

function assignRoomsToState(
  rooms: DerivedRoom[],
  state: NurseState[],
  capacities: NurseCapacity[],
): Map<string, number> {
  const capacityMap = new Map(capacities.map((cap) => [cap.nurseId, cap.capacity]));
  const assignment = new Map<string, number>();
  let roundRobinIndex = 0;

  const assignWithScoring = (room: DerivedRoom) => {
    if (assignment.has(room.room)) return;
    const chosen = pickNurse(room, state, capacities, capacityMap);
    updateNurseState(chosen, room, state);
    assignment.set(room.room, chosen);
  };

  const getRoundRobinOrder = (): NurseState[] => {
    return Array.from({ length: state.length }, (_, offset) => {
      const idx = (roundRobinIndex + offset) % state.length;
      return state[idx];
    });
  };

  const assignRoundRobin = (data: DerivedRoom[], direction: SortDirection = 'oldest') => {
    const ordered = sortByAgeThenTime(data, direction).filter((room) => !assignment.has(room.room));
    ordered.forEach((room) => {
      const candidates = getRoundRobinOrder().filter((nurse) => nurse.remaining > 0);
      if (candidates.length === 0) {
        throw new Error('No available nurse capacity for round-robin assignment.');
      }

      const avoidDuplicates = candidates.filter((nurse) => {
        if (room.bfi === 'Y' && nurse.hasBfi) return false;
        if (room.cs === 'Y' && nurse.hasCs) return false;
        return true;
      });

      const chosen = avoidDuplicates[0] ?? candidates[0];
      const chosenIndex = state.findIndex((n) => n.nurseId === chosen.nurseId);
      updateNurseState(chosen.nurseId, room, state);
      assignment.set(room.room, chosen.nurseId);
      roundRobinIndex = (chosenIndex + 1) % state.length;
    });
  };

  const assignSequence = (data: DerivedRoom[], direction: SortDirection = 'oldest') => {
    sortByAgeThenTime(data, direction)
      .filter((room) => !assignment.has(room.room))
      .forEach(assignWithScoring);
  };

  const dischargeRooms = rooms.filter((room) => room.discharge === 'Y');
  const youngRooms = rooms.filter((room) => room.under_24 === 'Y');
  const oldRooms = rooms.filter((room) => room.over_24 === 'Y');

  assignRoundRobin(dischargeRooms);
  assignRoundRobin(youngRooms);
  assignRoundRobin(oldRooms);

  const remainingRooms = rooms.filter((room) => !assignment.has(room.room));
  assignSequence(remainingRooms);

  return assignment;
}

export function assignRooms(
  rows: AssignmentInputRow[],
  nNurses: number,
  tz: string,
): AssignmentResult {
  if (rows.length === 0) {
    return { perNurse: [], perRoom: [] };
  }

  const capacities = computeCapacities(rows.length, nNurses);
  const derived: DerivedRoom[] = rows.map((row) => {
    const workload = roomWorkload(row);
    const groupKey = roomGroupKey(row.room);
    const randKey = stablePseudoRandomKey(row.room, row.timeParsed);
    const wEffective = makeEffectiveLoad(row.timeParsed, workload);
    return {
      ...row,
      workload,
      groupKey,
      randKey,
      wEffective,
    };
  });

  const assignmentMap = assignRoomsToState(derived, buildInitialState(capacities), capacities);
  const rankOldest = denseRankOldest(derived);
  const totalRooms = derived.length;

  const perRoom: RoomAssignmentRow[] = derived
    .filter((room) => assignmentMap.has(room.room))
    .map((room) => {
      const oldestRank = rankOldest.get(room.room) ?? 1;
      return {
        room: room.room,
        time: room.timeParsed,
        rank_oldest: oldestRank,
        rank_youngest: totalRooms - oldestRank + 1,
        nurse_id: assignmentMap.get(room.room)!,
        discharge: room.discharge,
        under_24: room.under_24,
        over_24: room.over_24,
        baby_in_scn: room.baby_in_scn,
        gyn: room.gyn,
        bfi: room.bfi,
        cs: room.cs,
        vag: room.vag,
      };
    })
    .sort((a, b) => a.nurse_id - b.nurse_id || a.rank_oldest - b.rank_oldest);

  const perNurse: NurseSummaryRow[] = Array.from({ length: nNurses }, (_, idx) => {
    const nurseId = idx + 1;
    const roomsForNurse = perRoom.filter((room) => room.nurse_id === nurseId);
    const nRooms = roomsForNurse.length;
    const oldestRank = nRooms ? Math.min(...roomsForNurse.map((room) => room.rank_oldest)) : null;
    const youngestRank = nRooms ? Math.max(...roomsForNurse.map((room) => room.rank_youngest)) : null;

    const labelCounts = labelColumns.reduce((acc, col) => {
      const countKey = `n_${col.key}` as LabelCountKey;
      const count = roomsForNurse.filter((room) => room[col.key] === 'Y').length;
      return { ...acc, [countKey]: count };
    }, {} as Record<LabelCountKey, number>);

    const assignedRooms = roomsForNurse.map((room) => buildRoomLabel(room, tz)).join(', ');

    return {
      nurse_id: nurseId,
      assigned_rooms: assignedRooms,
      n_rooms: nRooms,
      oldest_rank_received: oldestRank,
      youngest_rank_received: youngestRank,
      ...labelCounts,
    };
  });

  return { perNurse, perRoom };
}

export function isValidRoom(room: string | null | undefined): boolean {
  if (!room) return false;
  return canonicalRooms.includes(room as (typeof canonicalRooms)[number]);
}

export function formatRoomLabel(room: string): string {
  return canonicalRooms.includes(room as (typeof canonicalRooms)[number]) ? room : `${room} (unknown)`;
}
