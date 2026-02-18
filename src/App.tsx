import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import './App.css';
import { canonicalRooms, labelColumns, type LabelKey } from './constants';
import type { LabelCountKey, NurseSummaryRow, RoomAssignmentRow, RoomRow } from './types';
import { assignRooms, buildRoomLabel, type AssignmentResult } from './utils/assignment';
import { createEmptyRow, parseRuntimeTable } from './utils/parser';
import { formatClock } from './utils/time';
import { useDebouncedValue } from './hooks/useDebouncedValue';

const STORAGE_KEY = 'charge-app-state/v1';

type PersistedShape = {
  rows: RoomRow[];
  nNurses: number;
  timezone: string;
  lastSaved?: number;
  dischargeHistory?: DischargeEvent[];
  servedCounts?: number[];
  assignmentSnapshot?: SerializedAssignmentResult | null;
  collapsedSections?: Partial<Record<SectionKey, boolean>>;
  servedByRoom?: RoomServeHistory;
};

type DischargeEvent = {
  id: string;
  nurseId: number | null;
  room: string;
  label: string;
  timestamp: number;
};

type SerializedRoomAssignmentRow = Omit<RoomAssignmentRow, 'time'> & {
  timeISO: string;
};

type SerializedAssignmentResult = {
  perRoom: SerializedRoomAssignmentRow[];
  perNurse: NurseSummaryRow[];
};

type RoomServeHistory = Record<string, number[]>;

type SectionKey = 'rooms' | 'perRoom' | 'controls' | 'dischargeLog' | 'runtimeTable';

const defaultCollapsedState: Record<SectionKey, boolean> = {
  rooms: false,
  perRoom: false,
  controls: false,
  dischargeLog: false,
  runtimeTable: false,
};

const sectionContentIds: Record<SectionKey, string> = {
  rooms: 'section-rooms-content',
  perRoom: 'section-per-room-content',
  controls: 'section-controls-content',
  dischargeLog: 'section-discharge-content',
  runtimeTable: 'section-runtime-content',
};

const serialiseAssignmentResult = (assignment: AssignmentResult | null): SerializedAssignmentResult | null => {
  if (!assignment) return null;
  const perRoom = assignment.perRoom
    .map((room) => {
      const { time, ...rest } = room;
      const iso = time.toISO() ?? time.toUTC().toISO() ?? new Date(time.toMillis()).toISOString();
      return { ...rest, timeISO: iso };
    });
  return {
    perRoom,
    perNurse: assignment.perNurse,
  };
};

const hydrateAssignmentResult = (payload?: SerializedAssignmentResult | null): AssignmentResult | null => {
  if (!payload) return null;
  const perRoom: RoomAssignmentRow[] = payload.perRoom
    .map((row) => {
      const { timeISO, ...rest } = row;
      const parsed = DateTime.fromISO(timeISO);
      if (!parsed.isValid) return null;
      return { ...rest, time: parsed };
    })
    .filter((row): row is RoomAssignmentRow => row !== null);
  if (perRoom.length === 0 && payload.perRoom.length > 0) {
    return null;
  }
  return {
    perRoom,
    perNurse: Array.isArray(payload.perNurse) ? payload.perNurse : [],
  };
};

const sanitiseServeHistory = (raw?: unknown): RoomServeHistory => {
  if (!raw || typeof raw !== 'object') return {};
  return Object.entries(raw as Record<string, unknown>).reduce((acc, [room, value]) => {
    if (!room || typeof room !== 'string') return acc;
    if (!Array.isArray(value)) return acc;
    const filtered = value.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    if (filtered.length === 0) return acc;
    acc[room] = Array.from(new Set(filtered));
    return acc;
  }, {} as RoomServeHistory);
};

const ensureRowShape = (raw?: Partial<RoomRow>): RoomRow => {
  const base = createEmptyRow();
  if (!raw) return base;

  const next: RoomRow = {
    ...base,
    ...raw,
    room: typeof raw.room === 'string' ? raw.room : '',
    time: typeof raw.time === 'string' ? raw.time : '',
  };

  labelColumns.forEach((col) => {
    next[col.key] = Boolean(raw?.[col.key]);
  });

  return next;
};

const formatSavedLabel = (timestamp: number | null) => {
  if (!timestamp) return 'Not yet saved';
  const date = new Date(timestamp);
  return `Saved locally ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

const makeSampleRow = (
  room: string,
  time: string,
  flags: Partial<Record<LabelKey, boolean>> = {},
): RoomRow => {
  const row = createEmptyRow();
  row.room = room;
  row.time = time;
  labelColumns.forEach(({ key }) => {
    row[key] = Boolean(flags[key as LabelKey]);
  });
  return row;
};

const TEST_ROWS: RoomRow[] = [
  makeSampleRow('1', '08:00', { discharge: true, under_24: true }),
  makeSampleRow('3', '08:30', { under_24: true, cs: true }),
  makeSampleRow('5', '09:10', { under_24: true, vag: true }),
  makeSampleRow('7', '09:45', { over_24: true }),
  makeSampleRow('9', '10:15', { bfi: true, over_24: true }),
  makeSampleRow('11', '10:50', { cs: true, over_24: true }),
  makeSampleRow('14-1', '11:30', { gyn: true }),
  makeSampleRow('14-2', '11:45', { discharge: true }),
  makeSampleRow('16-1', '12:10', { over_24: true }),
  makeSampleRow('16-2', '12:25', { under_24: true, vag: true }),
];

const describeRoom = (room: RoomAssignmentRow, tz: string) => {
  const tags = labelColumns
    .filter((col) => room[col.key] === 'Y')
    .map((col) => col.label);
  const tagStr = tags.length > 0 ? tags.join(', ') : 'No special tags';
  return `${room.room} • ${formatClock(room.time, tz)} • ${tagStr}`;
};

const badgeClassForRoom = (room: RoomAssignmentRow) => {
  if (room.under_24 === 'Y') return 'pill-under';
  if (room.over_24 === 'Y') return 'pill-over';
  return '';
};

const triggerDownload = (filename: string, contents: string, mime = 'text/plain') => {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const buildNurseSummary = (perRoom: RoomAssignmentRow[], nNurses: number, tz: string): NurseSummaryRow[] => {
  return Array.from({ length: nNurses }, (_, idx) => {
    const nurseId = idx + 1;
    const roomsForNurse = perRoom.filter((room) => room.nurse_id === nurseId);
    const labelCounts = labelColumns.reduce((acc, col) => {
      const countKey = `n_${col.key}` as LabelCountKey;
      const count = roomsForNurse.filter((room) => room[col.key] === 'Y').length;
      return { ...acc, [countKey]: count };
    }, {} as Record<LabelCountKey, number>);

    const assignedRooms = roomsForNurse.map((room) => buildRoomLabel(room, tz)).join(', ');
    const oldestRank = roomsForNurse.length ? Math.min(...roomsForNurse.map((room) => room.rank_oldest)) : null;
    const youngestRank = roomsForNurse.length ? Math.max(...roomsForNurse.map((room) => room.rank_youngest)) : null;

    return {
      nurse_id: nurseId,
      assigned_rooms: assignedRooms,
      n_rooms: roomsForNurse.length,
      oldest_rank_received: oldestRank,
      youngest_rank_received: youngestRank,
      ...labelCounts,
    };
  });
};

const ensureCountsLength = (counts: number[], nNurses: number) => {
  const next = [...counts];
  if (next.length > nNurses) return next.slice(0, nNurses);
  while (next.length < nNurses) next.push(0);
  return next;
};

const mergeAssignments = (
  previous: AssignmentResult | null,
  next: AssignmentResult,
  nNurses: number,
  tz: string,
  servedCounts: number[],
  servedHistory: RoomServeHistory,
): { result: AssignmentResult; updatedServedCounts: number[]; updatedServedByRoom: RoomServeHistory } => {
  const counts = ensureCountsLength(servedCounts, nNurses);
  const history: RoomServeHistory = Object.entries(servedHistory).reduce((acc, [room, ids]) => {
    acc[room] = Array.from(new Set(ids));
    return acc;
  }, {} as RoomServeHistory);

  if (!previous) {
    next.perRoom.forEach((room) => {
      const recorded = history[room.room] ?? [];
      if (!recorded.includes(room.nurse_id)) {
        history[room.room] = [...recorded, room.nurse_id];
        const idx = room.nurse_id - 1;
        if (idx >= 0) {
          counts[idx] = (counts[idx] ?? 0) + 1;
        }
      }
    });
    const activeRooms = new Set(next.perRoom.map((room) => room.room));
    Object.keys(history).forEach((room) => {
      if (!activeRooms.has(room)) delete history[room];
    });
    return { result: next, updatedServedCounts: counts, updatedServedByRoom: history };
  }

  const nextByRoom = new Map(next.perRoom.map((room) => [room.room, room]));
  const prevRooms = previous.perRoom;
  const preserved = prevRooms
    .filter((room) => nextByRoom.has(room.room))
    .map((room) => {
      const updated = nextByRoom.get(room.room)!;
      return { ...updated, nurse_id: room.nurse_id };
    });

  const prevRoomNames = new Set(prevRooms.map((room) => room.room));
  const appended = next.perRoom.filter((room) => !prevRoomNames.has(room.room));

  const nurseCounts = new Map<number, number>();
  preserved.forEach((room) => {
    nurseCounts.set(room.nurse_id, (nurseCounts.get(room.nurse_id) ?? 0) + 1);
  });

  const assignedNewRooms = appended.map((room) => {
    const candidates = Array.from({ length: nNurses }, (_, idx) => idx + 1).sort((a, b) => {
      const servedDiff = (counts[a - 1] ?? 0) - (counts[b - 1] ?? 0);
      if (servedDiff !== 0) return servedDiff;
      const activeDiff = (nurseCounts.get(a) ?? 0) - (nurseCounts.get(b) ?? 0);
      if (activeDiff !== 0) return activeDiff;
      return a - b;
    });
    const chosen = candidates[0] ?? 1;
    nurseCounts.set(chosen, (nurseCounts.get(chosen) ?? 0) + 1);
    return { ...room, nurse_id: chosen };
  });

  const perRoom = [...preserved, ...assignedNewRooms];
  perRoom.forEach((room) => {
    const recorded = history[room.room] ?? [];
    if (!recorded.includes(room.nurse_id)) {
      history[room.room] = [...recorded, room.nurse_id];
      const idx = room.nurse_id - 1;
      if (idx >= 0) {
        counts[idx] = (counts[idx] ?? 0) + 1;
      }
    }
  });

  const activeRooms = new Set(perRoom.map((room) => room.room));
  Object.keys(history).forEach((room) => {
    if (!activeRooms.has(room)) {
      delete history[room];
    }
  });

  const perNurse = buildNurseSummary(perRoom, nNurses, tz);
  return { result: { perRoom, perNurse }, updatedServedCounts: counts, updatedServedByRoom: history };
};

function App() {
  const [rows, setRows] = useState<RoomRow[]>(() => [createEmptyRow()]);
  const [nNurses, setNNurses] = useState(4);
  const [timezone, setTimezone] = useState('America/Toronto');
  const [hydrated, setHydrated] = useState(false);
  const [lastSavedTs, setLastSavedTs] = useState<number | null>(null);
  const [assignmentSnapshot, setAssignmentSnapshot] = useState<AssignmentResult | null>(null);
  const [dischargeHistory, setDischargeHistory] = useState<DischargeEvent[]>([]);
  const [draggingRoomId, setDraggingRoomId] = useState<string | null>(null);
  const [nurseServedCounts, setNurseServedCounts] = useState<number[]>([]);
  const [collapsedSections, setCollapsedSections] = useState<Record<SectionKey, boolean>>(defaultCollapsedState);
  const [servedByRoom, setServedByRoom] = useState<RoomServeHistory>({});
  const isSectionCollapsed = (key: SectionKey) => collapsedSections[key];
  const toggleSection = (key: SectionKey) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const creditRoomForNurse = (roomId: string, nurseId: number) => {
    if (!roomId || nurseId <= 0) return;
    setServedByRoom((prev) => {
      const prior = prev[roomId] ?? [];
      if (prior.includes(nurseId)) return prev;
      const updatedHistory = { ...prev, [roomId]: [...prior, nurseId] };
      setNurseServedCounts((countsPrev) => {
        const next = ensureCountsLength(countsPrev, nNurses);
        const idx = nurseId - 1;
        if (idx >= 0) {
          next[idx] = (next[idx] ?? 0) + 1;
        }
        return next;
      });
      return updatedHistory;
    });
  };
  const resetRoomHistory = (roomId: string) => {
    if (!roomId) return;
    setServedByRoom((prev) => {
      if (!(roomId in prev)) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      setHydrated(true);
      return;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedShape;
      if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
        setRows(parsed.rows.map((r) => ensureRowShape(r)));
      }
      if (typeof parsed.nNurses === 'number' && parsed.nNurses >= 1) {
        setNNurses(parsed.nNurses);
      }
      if (typeof parsed.timezone === 'string' && parsed.timezone.trim()) {
        setTimezone(parsed.timezone);
      }
      if (typeof parsed.lastSaved === 'number') {
        setLastSavedTs(parsed.lastSaved);
      }
      if (Array.isArray(parsed.dischargeHistory)) {
        setDischargeHistory(parsed.dischargeHistory);
      }
      if (Array.isArray(parsed.servedCounts)) {
        setNurseServedCounts(parsed.servedCounts);
      }
      if (parsed.assignmentSnapshot) {
        const restored = hydrateAssignmentResult(parsed.assignmentSnapshot);
        if (restored) {
          setAssignmentSnapshot(restored);
        }
      }
      const collapsedPrefs = parsed.collapsedSections;
      if (collapsedPrefs && typeof collapsedPrefs === 'object') {
        setCollapsedSections((prev) => {
          const next = { ...prev };
          (Object.keys(collapsedPrefs) as SectionKey[]).forEach((key) => {
            const value = collapsedPrefs[key];
            if (typeof value === 'boolean' && key in next) {
              next[key] = value;
            }
          });
          return next;
        });
      }
      if (parsed.servedByRoom) {
        setServedByRoom(sanitiseServeHistory(parsed.servedByRoom));
      }
    } catch (error) {
      console.warn('Unable to restore saved state', error);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return;
    const lastSaved = Date.now();
    const payload: PersistedShape = {
      rows,
      nNurses,
      timezone,
      lastSaved,
      dischargeHistory,
      servedCounts: nurseServedCounts,
      assignmentSnapshot: serialiseAssignmentResult(assignmentSnapshot),
      collapsedSections,
      servedByRoom,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    setLastSavedTs(lastSaved);
  }, [rows, nNurses, timezone, dischargeHistory, nurseServedCounts, assignmentSnapshot, collapsedSections, servedByRoom, hydrated]);

  useEffect(() => {
    setNurseServedCounts((prev) => {
      const next = [...prev];
      if (next.length > nNurses) {
        return next.slice(0, nNurses);
      }
      while (next.length < nNurses) {
        next.push(0);
      }
      return next;
    });
  }, [nNurses]);

  const debouncedRows = useDebouncedValue(rows, 250);
  const debouncedTimezone = useDebouncedValue(timezone, 250);
  const parseResult = useMemo(
    () => parseRuntimeTable(debouncedRows, debouncedTimezone),
    [debouncedRows, debouncedTimezone],
  );
  const parseStateFresh = rows === debouncedRows && timezone === debouncedTimezone;
  const savedLabel = formatSavedLabel(lastSavedTs);

  const rowMeta = useMemo(() => {
    const map = new Map<number, (typeof parseResult.rows)[number]>();
    parseResult.rows.forEach((row) => map.set(row.rowIndex, row));
    return map;
  }, [parseResult.rows]);
  const assignedRoomsSet = useMemo(() => {
    if (!assignmentSnapshot) return new Set<string>();
    return new Set(assignmentSnapshot.perRoom.map((room) => room.room));
  }, [assignmentSnapshot]);

  const cautionByRow = useMemo(() => {
    const map = new Map<number, string>();
    parseResult.rows.forEach((row) => {
      const missingAgeFlag = row.room && row.time && row.under_24 !== 'Y' && row.over_24 !== 'Y';
      if (missingAgeFlag) {
        map.set(row.rowIndex, 'Flag either under_24 or over_24 to prioritize appropriately.');
      }
    });
    return map;
  }, [parseResult.rows]);

  const validationMessages: string[] = [];

  if (!parseResult.timezoneValid) {
    validationMessages.push(`Timezone "${timezone || '(blank)'}" is not recognized.`);
  }
  if (parseResult.duplicateRooms.length > 0) {
    validationMessages.push(`Duplicate room entries: ${parseResult.duplicateRooms.join(', ')}`);
  }
  if (parseResult.invalidRooms.length > 0) {
    validationMessages.push(`Invalid room(s) not in roster: ${parseResult.invalidRooms.join(', ')}`);
  }
  if (parseResult.invalidTimes.length > 0) {
    validationMessages.push(`Unparseable time(s) (expected HH:MM): ${parseResult.invalidTimes.join(', ')}`);
  }
  if (parseResult.both24Count > 0) {
    validationMessages.push(`Rows with both under_24='Y' and over_24='Y': ${parseResult.both24Count}`);
  }

  const warnings: string[] = [];
  const cautionRows = parseResult.rows.filter(
    (row) => row.room && row.time && row.under_24 !== 'Y' && row.over_24 !== 'Y',
  );
  if (cautionRows.length > 0) {
    warnings.push(`${cautionRows.length} row(s) missing under_24/over_24 tag. These are not blocking assignments but reduce clarity.`);
  }

  const canAssign = validationMessages.length === 0 && parseResult.assignmentRows.length > 0;

  const pendingAssignment = useMemo(() => {
    if (!canAssign) return null;
    return assignRooms(parseResult.assignmentRows, nNurses, timezone);
  }, [canAssign, parseResult.assignmentRows, nNurses, timezone]);

  const activeAssignments = assignmentSnapshot;

  const hasPendingChanges = useMemo(() => {
    if (!pendingAssignment) return false;
    if (!activeAssignments) return true;
    const activeMap = new Map(activeAssignments.perRoom.map((room) => [room.room, room]));
    if (pendingAssignment.perRoom.length !== activeAssignments.perRoom.length) return true;
    return pendingAssignment.perRoom.some((room) => {
      const activeRoom = activeMap.get(room.room);
      if (!activeRoom) return true;
      return activeRoom.time.toMillis() !== room.time.toMillis();
    });
  }, [pendingAssignment, activeAssignments]);

  const handleAssign = () => {
    if (!pendingAssignment) return;
    const merged = mergeAssignments(
      assignmentSnapshot,
      pendingAssignment,
      nNurses,
      timezone,
      nurseServedCounts,
      servedByRoom,
    );
    setAssignmentSnapshot(merged.result);
    setNurseServedCounts(merged.updatedServedCounts);
    setServedByRoom(merged.updatedServedByRoom);
  };

  const handleDragStart = (roomId: string) => {
    setDraggingRoomId(roomId);
  };

  const handleDragEnd = () => setDraggingRoomId(null);

  const handleDropOnNurse = (nurseId: number) => {
    if (!draggingRoomId) return;
    let updated = false;
    let movedRoom: string | null = null;
    setAssignmentSnapshot((prev) => {
      if (!prev) return prev;
      const target = prev.perRoom.find((room) => room.room === draggingRoomId);
      if (!target || target.nurse_id === nurseId) return prev;
      updated = true;
      movedRoom = target.room;
      const perRoom = prev.perRoom.map((room) =>
        room.room === draggingRoomId ? { ...room, nurse_id: nurseId } : room,
      );
      return {
        perRoom,
        perNurse: buildNurseSummary(perRoom, nNurses, timezone),
      };
    });
    setDraggingRoomId(null);
    if (updated && movedRoom) {
      creditRoomForNurse(movedRoom, nurseId);
    }
  };

  const summaryStats = useMemo(
    () => [
      { label: 'Captured rows', value: rows.length, caption: 'in the grid' },
      { label: 'Ready to assign', value: parseResult.assignmentRows.length, caption: 'valid entries' },
      {
        label: 'Assigned rooms',
        value: activeAssignments?.perRoom.length ?? 0,
        caption: 'current distribution',
      },
      {
        label: 'Alerts',
        value: validationMessages.length + warnings.length,
        caption: 'issues to review',
      },
    ],
    [rows.length, parseResult.assignmentRows.length, activeAssignments?.perRoom.length, validationMessages.length, warnings.length],
  );

  const exportTablesAsCsv = () => {
    if (!activeAssignments) return;
    const escape = (value: string | number | null | undefined) => {
      const str = value ?? '';
      if (typeof str === 'number') return String(str);
      if (str.includes(',') || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const nurseHeader = ['Nurse', '# Rooms', 'Assigned rooms', 'Oldest rank', 'Youngest rank', ...labelColumns.map((col) => `n_${col.key}`)];
    const nurseRows = activeAssignments.perNurse.map((row) => [
      row.nurse_id,
      row.n_rooms,
      row.assigned_rooms,
      row.oldest_rank_received ?? '',
      row.youngest_rank_received ?? '',
      ...labelColumns.map((col) => row[`n_${col.key}` as LabelCountKey]),
    ]);

    const roomHeader = ['Nurse', 'Room', 'Time', 'Rank oldest', 'Rank youngest', ...labelColumns.map((col) => col.label)];
    const roomRows = activeAssignments.perRoom.map((room) => [
      room.nurse_id,
      room.room,
      formatClock(room.time, timezone),
      room.rank_oldest,
      room.rank_youngest,
      ...labelColumns.map((col) => (room[col.key] === 'Y' ? 'Y' : '')),
    ]);

    const csv = [
      'Nurse Summary',
      nurseHeader.map(escape).join(','),
      ...nurseRows.map((row) => row.map(escape).join(',')),
      '',
      'Per-room assignments',
      roomHeader.map(escape).join(','),
      ...roomRows.map((row) => row.map(escape).join(',')),
    ].join('\n');

    triggerDownload('assignments.csv', csv, 'text/csv');
  };

  const generateAssignmentsReport = () => {
    if (!activeAssignments) return;
    const lines: string[] = [];
    lines.push(`Assignments Report — ${new Date().toLocaleString()}`);
    lines.push('');
    activeAssignments.perNurse.forEach((nurse) => {
      lines.push(`Nurse ${nurse.nurse_id} (${nurse.n_rooms} rooms)`);
      const rooms = activeAssignments.perRoom.filter((room) => room.nurse_id === nurse.nurse_id);
      if (rooms.length === 0) {
        lines.push('  • No rooms assigned');
      } else {
        rooms.forEach((room) => {
          const tags = labelColumns.filter((col) => room[col.key] === 'Y').map((col) => col.label);
          const tagStr = tags.length ? ` — ${tags.join(', ')}` : '';
          lines.push(`  • ${room.room} at ${formatClock(room.time, timezone)}${tagStr}`);
        });
      }
      lines.push('');
    });
    triggerDownload('assignment-report.txt', lines.join('\n'), 'text/plain');
  };

  const updateRowField = <K extends keyof RoomRow>(index: number, field: K, value: RoomRow[K]) => {
    let updatedRoom: string | null = null;
    let updatedDischarge: boolean | null = null;
    setRows((prev) => {
      const next = [...prev];
      const updated = { ...next[index], [field]: value };
      next[index] = updated;
      if (field === 'discharge') {
        updatedRoom = updated.room?.trim() || null;
        updatedDischarge = Boolean(value);
      }
      return next;
    });
    if (updatedRoom !== null && updatedDischarge !== null) {
      const newFlagValue: '' | 'Y' = updatedDischarge ? 'Y' : '';
      setAssignmentSnapshot((prev) => {
        if (!prev) return prev;
        let touched = false;
        const perRoom = prev.perRoom.map((room) => {
          if (room.room === updatedRoom) {
            touched = true;
            return { ...room, discharge: newFlagValue };
          }
          return room;
        });
        if (!touched) return prev;
        return {
          perRoom,
          perNurse: buildNurseSummary(perRoom, nNurses, timezone),
        };
      });
    }
  };

  const addRow = () => setRows((prev) => [...prev, createEmptyRow()]);
  const dischargeRow = (index: number) => {
    const roomId = rows[index]?.room?.trim();
    if (roomId && assignmentSnapshot) {
      const entry = assignmentSnapshot.perRoom.find((room) => room.room === roomId);
      if (entry) {
        setDischargeHistory((prev) => [
          {
            id: `${roomId}-${Date.now()}`,
            nurseId: entry.nurse_id,
            room: entry.room,
            label: buildRoomLabel(entry, timezone),
            timestamp: Date.now(),
          },
          ...prev,
        ].slice(0, 50));
        setAssignmentSnapshot((prev) => {
          if (!prev) return prev;
          const perRoom = prev.perRoom.filter((room) => room.room !== roomId);
          const perNurse = buildNurseSummary(perRoom, nNurses, timezone);
          return { perRoom, perNurse };
        });
        resetRoomHistory(roomId);
      }
    }
    setRows((prev) => {
      const next = [...prev];
      next[index] = createEmptyRow();
      return next;
    });
  };
  const removeRow = (index: number) => {
    const roomId = rows[index]?.room?.trim();
    if (roomId) resetRoomHistory(roomId);
    setRows((prev) => {
      if (prev.length === 1) return [createEmptyRow()];
      return prev.filter((_, i) => i !== index);
    });
  };
  const promoteToOver24 = (index: number) => {
    setRows((prev) => {
      const next = [...prev];
      const row = next[index];
      if (!row) return prev;
      next[index] = { ...row, under_24: false, over_24: true };
      return next;
    });
  };
  const togglePrepareDischarge = (index: number) => {
    let updatedRoom: string | null = null;
    let updatedFlag = false;
    setRows((prev) => {
      const next = [...prev];
      const row = next[index];
      if (!row) return prev;
      const updated = { ...row, discharge: !row.discharge };
      next[index] = updated;
      updatedRoom = updated.room?.trim() || null;
      updatedFlag = updated.discharge;
      return next;
    });
    if (updatedRoom) {
      const newFlagValue: '' | 'Y' = updatedFlag ? 'Y' : '';
      setAssignmentSnapshot((prev) => {
        if (!prev) return prev;
        let touched = false;
        const perRoom = prev.perRoom.map((room) => {
          if (room.room === updatedRoom) {
            touched = true;
            return { ...room, discharge: newFlagValue };
          }
          return room;
        });
        if (!touched) return prev;
        return {
          perRoom,
          perNurse: buildNurseSummary(perRoom, nNurses, timezone),
        };
      });
    }
  };
  const clearTable = () => {
    setRows([createEmptyRow()]);
    setAssignmentSnapshot(null);
    setDischargeHistory([]);
    setNurseServedCounts(Array.from({ length: nNurses }, () => 0));
    setServedByRoom({});
  };

  const loadTestData = () => {
    setRows(TEST_ROWS.map((row) => ({ ...row })));
    setAssignmentSnapshot(null);
    setDischargeHistory([]);
    setNurseServedCounts(Array.from({ length: nNurses }, () => 0));
    setServedByRoom({});
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Room-to-Nurse Assignment</h1>
          <p className="subtitle">Primary outputs first, responsive editing always available.</p>
        </div>
        <span className="persist-meta">{savedLabel}</span>
      </header>

      <section className="panel highlight collapsible">
        <div className="panel-head">
          <div>
            <h2>Rooms by nurse</h2>
            <p>Deterministic, fair distribution across {nNurses} nurse(s).</p>
          </div>
          <button
            type="button"
            className="collapse-toggle"
            aria-controls={sectionContentIds.rooms}
            aria-expanded={!isSectionCollapsed('rooms')}
            onClick={() => toggleSection('rooms')}
          >
            {isSectionCollapsed('rooms') ? 'Expand' : 'Collapse'}
            <span className="chevron" aria-hidden="true" data-collapsed={isSectionCollapsed('rooms')} />
          </button>
        </div>
        <div
          id={sectionContentIds.rooms}
          className={`panel-content ${isSectionCollapsed('rooms') ? 'collapsed' : ''}`}
          aria-hidden={isSectionCollapsed('rooms')}
        >
          <div className="summary-grid">
            {summaryStats.map((stat) => (
              <div key={stat.label} className="stat-card">
                <span className="stat-label">{stat.label}</span>
                <span className="stat-value">{stat.value}</span>
                <span className="stat-caption">{stat.caption}</span>
              </div>
            ))}
          </div>
          <div className="assign-actions">
            <button
              type="button"
              onClick={handleAssign}
              disabled={!pendingAssignment || !hasPendingChanges}
            >
              Assign rooms
            </button>
            {!pendingAssignment && (
              <span className="assign-hint">Enter valid rooms to enable assignments.</span>
            )}
            {pendingAssignment && !hasPendingChanges && activeAssignments && (
              <span className="assign-hint">Assignments are up to date.</span>
            )}
          </div>
          {activeAssignments && (
            <div className="export-actions">
              <button type="button" onClick={exportTablesAsCsv}>
                Export tables (CSV)
              </button>
              <button type="button" className="ghost-button" onClick={generateAssignmentsReport}>
                Generate report
              </button>
            </div>
          )}
          {activeAssignments ? (
            <div className="card-grid">
              {activeAssignments.perNurse.map((row) => {
                const roomsForNurse = activeAssignments.perRoom.filter(
                  (room) => room.nurse_id === row.nurse_id,
                );
                return (
                  <article
                    key={`nurse-card-${row.nurse_id}`}
                    className={`nurse-card ${draggingRoomId ? 'drag-ready' : ''}`}
                    onDragOver={(e) => {
                      if (draggingRoomId) {
                        e.preventDefault();
                      }
                    }}
                    onDrop={(e) => {
                      if (!draggingRoomId) return;
                      e.preventDefault();
                      handleDropOnNurse(row.nurse_id);
                    }}
                  >
                    <header>
                      <h3>Nurse {row.nurse_id}</h3>
                      <span className="badge">{row.n_rooms} room(s)</span>
                    </header>
                    <p className="card-meta">
                      Oldest rank: {row.oldest_rank_received ?? '—'} • Youngest rank: {row.youngest_rank_received ?? '—'}
                    </p>
                    <div className="assigned-list">
                      {roomsForNurse.length > 0 ? (
                        roomsForNurse.map((room) => (
                          <span
                            key={`${row.nurse_id}-${room.room}-${room.rank_oldest}`}
                            className={`tag-pill draggable ${draggingRoomId === room.room ? 'dragging' : ''}`}
                            data-color={badgeClassForRoom(room)}
                            draggable
                            data-tooltip={describeRoom(room, timezone)}
                            onDragStart={() => handleDragStart(room.room)}
                            onDragEnd={handleDragEnd}
                          >
                            {room.room} ({formatClock(room.time, timezone)})
                          </span>
                        ))
                      ) : (
                        <span className="muted">No rooms assigned</span>
                      )}
                    </div>
                  {dischargeHistory.filter((event) => event.nurseId === row.nurse_id).length > 0 && (
                    <div className="assigned-list discharged">
                      {dischargeHistory
                        .filter((event) => event.nurseId === row.nurse_id)
                        .map((event) => {
                          const timeLabel = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                          return (
                            <span
                              key={event.id}
                              className="tag-pill discharged"
                              data-tooltip={`Discharged at ${timeLabel}`}
                              aria-label={`${event.label} discharged at ${timeLabel}`}
                            >
                              <span className="pill-text">{event.label}</span>
                              <span className="pill-time" aria-hidden="true">{timeLabel}</span>
                            </span>
                          );
                        })}
                    </div>
                  )}
                    <footer>
                      {labelColumns.map((col) => {
                        const countKey = `n_${col.key}` as LabelCountKey;
                        const value = row[countKey];
                        if (!value) return null;
                        const roomList = roomsForNurse
                          .filter((room) => room[col.key] === 'Y')
                          .map((room) => `${room.room} (${formatClock(room.time, timezone)})`)
                          .join(', ');
                        return (
                          <span
                            key={`${row.nurse_id}-${col.key}`}
                            className="count-pill"
                            data-tooltip={roomList || 'No rooms'}
                          >
                            {col.label}: {value}
                          </span>
                        );
                      })}
                    </footer>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="muted">Enter rooms and select “Assign rooms” to generate the distribution.</p>
          )}
        </div>
      </section>

      {activeAssignments && (
        <section className="panel collapsible">
          <div className="panel-head">
            <h2>Per-room assignments</h2>
            <button
              type="button"
              className="collapse-toggle"
              aria-controls={sectionContentIds.perRoom}
              aria-expanded={!isSectionCollapsed('perRoom')}
              onClick={() => toggleSection('perRoom')}
            >
              {isSectionCollapsed('perRoom') ? 'Expand' : 'Collapse'}
              <span className="chevron" aria-hidden="true" data-collapsed={isSectionCollapsed('perRoom')} />
            </button>
          </div>
          <div
            id={sectionContentIds.perRoom}
            className={`panel-content ${isSectionCollapsed('perRoom') ? 'collapsed' : ''}`}
            aria-hidden={isSectionCollapsed('perRoom')}
          >
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Nurse</th>
                    <th>Room</th>
                    <th>Time</th>
                    <th>Rank (oldest)</th>
                    <th>Rank (youngest)</th>
                    {labelColumns.map((col) => (
                      <th key={`room-${col.key}`} title={col.description}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeAssignments.perRoom.map((room) => (
                    <tr key={`${room.nurse_id}-${room.room}-${room.rank_oldest}`}>
                      <td data-label="Nurse">{room.nurse_id}</td>
                      <td data-label="Room">{room.room}</td>
                      <td data-label="Time">{formatClock(room.time, timezone)}</td>
                      <td data-label="Rank (oldest)">{room.rank_oldest}</td>
                      <td data-label="Rank (youngest)">{room.rank_youngest}</td>
                      {labelColumns.map((col) => (
                        <td key={`${room.room}-${col.key}`} data-label={col.label}>
                          {room[col.key] === 'Y' ? 'Y' : ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section className="panel controls-panel collapsible">
        <div className="panel-head">
          <h2>Controls & data entry</h2>
          <button
            type="button"
            className="collapse-toggle"
            aria-controls={sectionContentIds.controls}
            aria-expanded={!isSectionCollapsed('controls')}
            onClick={() => toggleSection('controls')}
          >
            {isSectionCollapsed('controls') ? 'Expand' : 'Collapse'}
            <span className="chevron" aria-hidden="true" data-collapsed={isSectionCollapsed('controls')} />
          </button>
        </div>
        <div
          id={sectionContentIds.controls}
          className={`panel-content ${isSectionCollapsed('controls') ? 'collapsed' : ''}`}
          aria-hidden={isSectionCollapsed('controls')}
        >
          <div className="controls-grid">
            <label>
              <span>Number of nurses</span>
              <input
                type="number"
                min={1}
              value={nNurses}
              onChange={(e) => setNNurses(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
          <label>
            <span>Timezone (single, consistent)</span>
            <input
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="e.g., America/Toronto"
            />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={addRow}>Add row</button>
            <button type="button" onClick={clearTable} className="secondary">Clear table</button>
            <button type="button" onClick={loadTestData} className="ghost-button">Load test data</button>
          </div>
          <p className="help-text">Time format: HH:MM (24-hour). Tags are not mutually exclusive, but avoid flagging both under_24 and over_24.</p>
        <div
          className={`validation ${validationMessages.length === 0 ? 'ok' : 'error'}`}
          role="status"
          aria-live="polite"
        >
          {validationMessages.length === 0 ? (
            <span>Validation: OK</span>
          ) : (
            <div>
              <strong>Validation issues:</strong>
              <ul>
                {validationMessages.map((msg) => (
                  <li key={msg}>{msg}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {warnings.length > 0 && (
          <div className="warning-box">
            <ul>
              {warnings.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
          </div>
        )}
        </div>
      </section>

      {dischargeHistory.length > 0 && (
        <section className="panel collapsible">
          <div className="panel-head">
            <h2>Discharge log</h2>
            <button
              type="button"
              className="collapse-toggle"
              aria-controls={sectionContentIds.dischargeLog}
              aria-expanded={!isSectionCollapsed('dischargeLog')}
              onClick={() => toggleSection('dischargeLog')}
            >
              {isSectionCollapsed('dischargeLog') ? 'Expand' : 'Collapse'}
              <span className="chevron" aria-hidden="true" data-collapsed={isSectionCollapsed('dischargeLog')} />
            </button>
          </div>
          <div
            id={sectionContentIds.dischargeLog}
            className={`panel-content ${isSectionCollapsed('dischargeLog') ? 'collapsed' : ''}`}
            aria-hidden={isSectionCollapsed('dischargeLog')}
          >
            <ul className="discharge-log">
              {dischargeHistory.slice(0, 10).map((event) => (
                <li key={event.id}>
                  <span className="log-room">{event.label}</span>
                  <span className="log-time">{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="panel collapsible">
        <div className="panel-head">
          <h2>Runtime input table (only occupied rooms)</h2>
          <button
            type="button"
            className="collapse-toggle"
            aria-controls={sectionContentIds.runtimeTable}
            aria-expanded={!isSectionCollapsed('runtimeTable')}
            onClick={() => toggleSection('runtimeTable')}
          >
            {isSectionCollapsed('runtimeTable') ? 'Expand' : 'Collapse'}
            <span className="chevron" aria-hidden="true" data-collapsed={isSectionCollapsed('runtimeTable')} />
          </button>
        </div>
        <div
          id={sectionContentIds.runtimeTable}
          className={`panel-content ${isSectionCollapsed('runtimeTable') ? 'collapsed' : ''}`}
          aria-hidden={isSectionCollapsed('runtimeTable')}
        >
          <div className="table-scroll">
            <table className="input-table">
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Time (HH:MM)</th>
                  {labelColumns.map((col) => (
                    <th key={col.key} title={col.description}>{col.label}</th>
                  ))}
                  <th>Status</th>
                  <th aria-label="Row actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .map((row, idx) => ({ row, idx }))
                  .sort((a, b) => {
                    const aKey = a.row.room ? canonicalRooms.indexOf(a.row.room as (typeof canonicalRooms)[number]) : canonicalRooms.length;
                    const bKey = b.row.room ? canonicalRooms.indexOf(b.row.room as (typeof canonicalRooms)[number]) : canonicalRooms.length;
                    return aKey - bKey;
                  })
                  .map(({ row, idx }) => {
                  const meta = parseStateFresh ? rowMeta.get(idx) : undefined;
                  const roomInvalid = !!meta?.room && !meta.roomOk;
                  const timeInvalid = !!meta?.time && !meta.timeOk;
                  const cautionText = parseStateFresh ? cautionByRow.get(idx) : undefined;
                  return (
                    <tr key={`row-${idx}`}>
                      <td data-label="Room">
                        <select
                          value={row.room}
                          onChange={(e) => updateRowField(idx, 'room', e.target.value)}
                          className={roomInvalid ? 'invalid' : ''}
                        >
                          <option value="">Select...</option>
                          {canonicalRooms
                            .filter((roomOption) => !assignedRoomsSet.has(roomOption) || row.room === roomOption)
                            .map((roomOption) => (
                              <option key={roomOption} value={roomOption}>
                                {roomOption}
                              </option>
                            ))}
                        </select>
                      </td>
                      <td data-label="Time">
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="HH:MM"
                          value={row.time}
                          onChange={(e) => updateRowField(idx, 'time', e.target.value)}
                          className={timeInvalid ? 'invalid' : ''}
                        />
                      </td>
                      {labelColumns.map((col) => (
                        <td key={`${col.key}-${idx}`} data-label={col.label} className="checkbox-cell">
                          <label className="checkbox" title={col.description}>
                            <span className="checkbox-caption" aria-hidden="true">{col.label}</span>
                            <input
                              type="checkbox"
                              checked={row[col.key]}
                              onChange={(e) => updateRowField(idx, col.key, e.target.checked)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  updateRowField(idx, col.key, !row[col.key]);
                                }
                              }}
                            />
                            <span className="sr-only">{col.label}</span>
                          </label>
                        </td>
                      ))}
                      <td data-label="Status">
                        {cautionText ? <span className="status-pill warning">Needs age tag</span> : <span className="status-pill ok">Ready</span>}
                      </td>
                      <td className="row-actions" data-label="Actions">
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => dischargeRow(idx)}
                        >
                          Discharge
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={!row.under_24}
                          onClick={() => promoteToOver24(idx)}
                        >
                          Promote 24h
                        </button>
                        <button
                          type="button"
                          className={`ghost ${row.discharge ? 'active' : ''}`}
                          onClick={() => togglePrepareDischarge(idx)}
                        >
                          Prep discharge
                        </button>
                        <button
                          type="button"
                          className="ghost danger"
                          onClick={() => removeRow(idx)}
                          aria-label="Remove row"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

export default App;
