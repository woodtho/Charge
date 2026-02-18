export const canonicalRooms = [
  '1', '3', '5', '7', '9', '11',
  '8-1', '8-2', '10-1', '10-2',
  '14-1', '14-2', '16-1', '16-2', '18-1', '18-2', '20-1', '20-2',
  '19', '21', '23', '25', '27',
  '32-1', '32-2', '32-3'
] as const;

export const labelColumns = [
  { key: 'discharge', label: 'Discharge', description: 'Discharging soon' },
  { key: 'under_24', label: 'Under 24h', description: 'Patient < 24hrs postpartum' },
  { key: 'over_24', label: 'Over 24h', description: 'Patient > 24hrs postpartum' },
  { key: 'baby_in_scn', label: 'Baby in SCN', description: 'Baby in special care nursery' },
  { key: 'gyn', label: 'Gyn', description: 'Gynecology patient' },
  { key: 'bfi', label: 'BFI', description: 'Baby-friendly initiative' },
  { key: 'cs', label: 'C-Section', description: 'Cesarean delivery' },
  { key: 'vag', label: 'Vaginal', description: 'Vaginal delivery' }
] as const;

export type LabelKey = (typeof labelColumns)[number]['key'];
