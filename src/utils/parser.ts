import { canonicalRooms, labelColumns, type LabelKey } from '../constants';
import type { AssignmentInputRow, ParsedRoomRow, RoomRow } from '../types';
import { isValidTimeZone, parseTimeToday } from './time';

export interface ValidationSummary {
  duplicateRooms: string[];
  invalidRooms: string[];
  invalidTimes: string[];
  both24Count: number;
  timezoneValid: boolean;
}

export interface ParseResult extends ValidationSummary {
  rows: ParsedRoomRow[];
  assignmentRows: AssignmentInputRow[];
}

export function createEmptyRow(): RoomRow {
  const labels = labelColumns.reduce((acc, col) => ({ ...acc, [col.key]: false }), {} as Record<LabelKey, boolean>);
  return {
    room: '',
    time: '',
    ...labels,
  };
}

function sanitiseRows(rows: RoomRow[]): ParsedRoomRow[] {
  return rows
    .map((row, idx) => {
      const trimmedRoom = row.room?.trim() ?? '';
      const trimmedTime = row.time?.trim() ?? '';
      const flags = labelColumns.reduce((acc, col) => ({
        ...acc,
        [col.key]: row[col.key] ? 'Y' : '' as 'Y' | '',
      }), {} as Record<LabelKey, 'Y' | ''>);
      return {
        rowIndex: idx,
        room: trimmedRoom || null,
        time: trimmedTime || null,
        ...flags,
        roomOk: false,
        timeOk: false,
        both24: false,
        timeParsed: null,
      };
    })
    .filter((row) => {
      const hasRoom = !!row.room;
      const hasTime = !!row.time;
      const hasTag = labelColumns.some((col) => row[col.key] === 'Y');
      return hasRoom || hasTime || hasTag;
    });
}

export function parseRuntimeTable(rows: RoomRow[], tz: string): ParseResult {
  const parsedRows = sanitiseRows(rows);
  const tzValid = isValidTimeZone(tz);

  const roomCounts = new Map<string, number>();

  const enrichedRows = parsedRows.map((row) => {
    if (row.room) {
      roomCounts.set(row.room, (roomCounts.get(row.room) ?? 0) + 1);
    }
    const roomOk = row.room ? canonicalRooms.includes(row.room as (typeof canonicalRooms)[number]) : false;

    const timeParsed = row.time && tzValid ? parseTimeToday(row.time, tz) : null;
    const timeOk = !!timeParsed;
    const both24 = row.under_24 === 'Y' && row.over_24 === 'Y';
    return {
      ...row,
      roomOk,
      timeOk,
      both24,
      timeParsed,
    };
  });

  const duplicateRooms = Array.from(roomCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([room]) => room);

  const invalidRooms = enrichedRows
    .filter((row) => row.room && !row.roomOk)
    .map((row) => row.room!)
    .filter((value, idx, arr) => arr.indexOf(value) === idx);

  const invalidTimes = tzValid
    ? enrichedRows
        .filter((row) => row.time && !row.timeOk)
        .map((row) => row.time!)
        .filter((value, idx, arr) => arr.indexOf(value) === idx)
    : [];

  const assignmentRows: AssignmentInputRow[] = enrichedRows
    .filter((row) => row.room && row.timeParsed)
    .map((row) => ({
      room: row.room!,
      timeParsed: row.timeParsed!,
      discharge: row.discharge,
      under_24: row.under_24,
      over_24: row.over_24,
      baby_in_scn: row.baby_in_scn,
      gyn: row.gyn,
      bfi: row.bfi,
      cs: row.cs,
      vag: row.vag,
    }));

  return {
    rows: enrichedRows,
    assignmentRows,
    duplicateRooms,
    invalidRooms,
    invalidTimes,
    both24Count: enrichedRows.filter((row) => row.both24).length,
    timezoneValid: tzValid,
  };
}
