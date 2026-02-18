import type { DateTime } from 'luxon';
import type { LabelKey } from './constants';

export type LabelFlags = Record<LabelKey, boolean>;

export interface RoomRow extends LabelFlags {
  room: string;
  time: string; // HH:MM entered by user
}

export type SanitizedRow = {
  room: string | null;
  time: string | null;
} & Record<LabelKey, 'Y' | ''>;

export interface ParsedRoomRow extends SanitizedRow {
  rowIndex: number;
  roomOk: boolean;
  timeOk: boolean;
  both24: boolean;
  timeParsed: DateTime | null;
}

export interface AssignmentInputRow extends Record<LabelKey, 'Y' | ''> {
  room: string;
  timeParsed: DateTime;
}

export interface RoomAssignmentRow extends Record<LabelKey, 'Y' | ''> {
  room: string;
  time: DateTime;
  rank_oldest: number;
  rank_youngest: number;
  nurse_id: number;
}

export type LabelCountKey = `n_${LabelKey}`;

export interface NurseSummaryRow extends Record<LabelCountKey, number> {
  nurse_id: number;
  assigned_rooms: string;
  n_rooms: number;
  oldest_rank_received: number | null;
  youngest_rank_received: number | null;
}
