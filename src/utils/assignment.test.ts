import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { assignRooms } from './assignment';
import type { AssignmentInputRow } from '../types';

const TZ = 'America/Toronto';

const makeRow = (
  room: string,
  time: string,
  flags: Partial<AssignmentInputRow> = {},
): AssignmentInputRow => {
  const [hour, minute] = time.split(':').map((value) => Number(value));
  const timeParsed = DateTime.fromObject(
    { year: 2025, month: 1, day: 1, hour, minute },
    { zone: TZ },
  );

  return {
    room,
    timeParsed,
    discharge: flags.discharge ?? '',
    under_24: flags.under_24 ?? '',
    over_24: flags.over_24 ?? '',
    baby_in_scn: flags.baby_in_scn ?? '',
    gyn: flags.gyn ?? '',
    bfi: flags.bfi ?? '',
    cs: flags.cs ?? '',
    vag: flags.vag ?? '',
  };
};

describe('assignRooms engine', () => {
  it('distributes discharges evenly before other rooms', () => {
    const rows: AssignmentInputRow[] = [
      makeRow('1', '08:00', { discharge: 'Y' }),
      makeRow('3', '08:30', { discharge: 'Y' }),
      makeRow('5', '09:00', { discharge: 'Y' }),
      makeRow('7', '09:30', { discharge: 'Y' }),
      makeRow('9', '10:00', { discharge: 'Y' }),
      makeRow('11', '10:30', { discharge: 'Y' }),
      makeRow('14-1', '11:00', {}),
      makeRow('14-2', '11:30', {}),
    ];

    const result = assignRooms(rows, 3, TZ);
    const dischargeCounts = result.perNurse.map((row) => row.n_discharge);

    expect(dischargeCounts.reduce((sum, count) => sum + count, 0)).toBe(6);
    const max = Math.max(...dischargeCounts);
    const min = Math.min(...dischargeCounts);
    expect(max - min).toBeLessThanOrEqual(1);
  });

  it('spreads BFI and C-Section flags across nurses when possible', () => {
    const rows: AssignmentInputRow[] = [
      makeRow('19', '06:00', { over_24: 'Y', bfi: 'Y' }),
      makeRow('21', '07:00', { over_24: 'Y', bfi: 'Y' }),
      makeRow('23', '08:00', { over_24: 'Y', bfi: 'Y' }),
      makeRow('25', '09:00', { over_24: 'Y', cs: 'Y' }),
      makeRow('27', '10:00', { over_24: 'Y', cs: 'Y' }),
      makeRow('32-1', '11:00', { over_24: 'Y', cs: 'Y' }),
    ];

    const result = assignRooms(rows, 3, TZ);

    result.perNurse.forEach((nurse) => {
      expect(nurse.n_bfi).toBeLessThanOrEqual(1);
      expect(nurse.n_cs).toBeLessThanOrEqual(1);
    });
  });

  it('remains deterministic for identical inputs', () => {
    const rows: AssignmentInputRow[] = [
      makeRow('1', '04:00', { discharge: 'Y' }),
      makeRow('3', '05:00', { over_24: 'Y' }),
      makeRow('5', '06:00', { under_24: 'Y', vag: 'Y' }),
      makeRow('7', '07:00', {}),
    ];

    const first = assignRooms(rows, 2, TZ);
    const second = assignRooms(rows, 2, TZ);

    expect(first).toEqual(second);
  });
});
