# agents.md

## Purpose
This repository implements a nurse-facing workflow for distributing occupied rooms across a fixed number of nurses. The application is used in real time (during active patient turnover) and must remain responsive during rapid edits. The core product output is **“Rooms by nurse”** and a secondary **per-room assignment** view.

The project is transitioning from a Shiny + rhandsontable prototype to a **React** application with a clear separation between:
- UI state/editing
- validation
- allocation/assignment engine (pure, deterministic)

## Product Requirements (Source of Truth)
### Inputs (per occupied room)
- `room` (canonical roster dropdown)
- `time` (HH:MM, interpreted in a single configured timezone, anchored to “today”)
- tags (non-mutually exclusive unless specified):
  - `discharge` (pending discharge; easier)
  - `under_24`, `over_24` (mutually exclusive with each other only)
  - `baby_in_scn` (easier)
  - `gyn` (easier; assigned last rule set)
  - `bfi` (breastfeeding issues; avoid multiple per nurse if possible)
  - `cs` (c-section; avoid multiple per nurse if possible)
  - `vag` (vaginal birth)

### Allocation Rules (Sequential, No Reassignment)
Assignment proceeds in phases. Once a room is assigned in an earlier phase, it must not be reassigned by later phases.

Phases:
1) **Random discharge**: allocate discharge rooms across nurses first using a deterministic pseudo-random ordering (stable across recomputes).
2) **Under 24 hours – C/S new → old**
3) **Under 24 hours – Vag new → old**
4) **Under 24 hours – C/S old → new** (rooms not already placed in phase 2)
5) **Under 24 hours – Vag old → new** (rooms not already placed in phase 3)
6) **Gyn**: remaining gyn rooms, new → old
7) **Everything else**: remaining rooms, old → new

### Constraints & Soft Preferences
- **Capacity balancing**: final room counts per nurse should be as even as possible.
- **Soft adjacency**: rooms with the same “group key” (e.g., 8-1 and 8-2 share group “8”) are preferred to stay with the same nurse as a tie-break.
- **Avoid duplicates if possible**:
  - Avoid multiple `cs` with the same nurse.
  - Avoid multiple `bfi` with the same nurse.
  These are **soft** constraints enforced via large penalties rather than hard infeasibility.

### Outputs
Primary:
- **Rooms by nurse** (prominent): a per-nurse list of assigned rooms with time and salient tags.

Secondary:
- **Per-room assignments** table: room, time, tags, assigned nurse, and age ranks.

Do **not** display derived internal columns (e.g., workload, effective load).

## Architectural Target
React app should be structured as:

- `packages/engine/` (or `src/engine/`):
  - Pure, deterministic allocation functions.
  - No React imports; no side effects.
  - 100% unit-test coverage for sorting phases and assignment invariants.

- `apps/web/` (or `src/`):
  - React UI components for editing, validation, and presentation.
  - Debounced computation to avoid lag while typing.
  - Deterministic state updates to prevent “edit → recompute → overwrite” loops.

Recommended stack:
- React + TypeScript
- State: Zustand or Redux Toolkit
- Table editing: TanStack Table + custom cell editors OR Handsontable (React wrapper) if spreadsheet UX is required.
- Validation: Zod
- Testing: Vitest + React Testing Library (UI), Vitest/Jest (engine)
- Formatting/linting: ESLint + Prettier
- Date/time: Luxon (preferred) or date-fns-tz

## Determinism & Performance Requirements
- Allocation must be deterministic for a given input dataset.
- “Random discharge” ordering must be **stable** (seedless deterministic hash based on room + time).
- No assignment should flicker due to non-deterministic iteration or unstable sorting.
- UI must not block while typing:
  - Use debounced recompute (e.g., 150–300ms).
  - Avoid regenerating the whole grid component on each keystroke.
  - Compute derived values in memoized selectors.

## Data Model (React/Engine Contract)
### RoomRow
Fields:
- `room: string`
- `timeHHMM: string` (raw user entry)
- `timeISO: string | null` (derived; today + HH:MM in configured tz)
- tags: each `boolean`
  - `discharge`, `under24`, `over24`, `babyInScn`, `gyn`, `bfi`, `cs`, `vag`

### Config
- `timezone: string` (IANA)
- `nNurses: number`
- `canonicalRooms: string[]`

### Results
- `assignments: Array<{ room: string; timeISO: string; nurseId: number; tags...; rankOldest: number; rankYoungest: number }>`
- `nurseSummary: Array<{ nurseId: number; assignedRooms: string; countsByTag: Record<string, number>; nRooms: number; oldestRankReceived?: number; youngestRankReceived?: number }>`

## Validation Requirements
Blocking validation errors:
- Duplicate `room` among occupied entries.
- `room` not in canonical roster.
- `timeHHMM` not parseable as HH:MM.
- `under24` and `over24` both true.

Non-blocking warnings (UI only):
- Neither `under24` nor `over24` set (treated as “unknown”; still eligible for later phases).

## Assignment Engine Specification
### Sorting within phases
- “new → old”: sort descending time (more recent time first).
- “old → new”: sort ascending time.
- Add stable tie-breakers:
  - `room` ascending
  - optional secondary `hashKey` for discharge phase only

### Discharge phase “random”
Use a deterministic hash:
- Key material: `${room}|${timeISO}`
- Hash function: stable integer hash (no crypto requirement).
Do not use `Math.random()`.

### Candidate scoring (choosing a nurse)
Each step assigns the next room to the best nurse among those with remaining capacity:
- Primary objective: balance projected room count and projected load (load is internal).
- Soft adjacency: tiny bonus if nurse already has the room’s group key.
- Soft constraints: large penalties if nurse already has cs/bfi and the new room is cs/bfi.

The engine must guarantee:
- One nurse per room.
- No reassignment across phases.
- Capacity never exceeded.

## UI Requirements
### Layout priority
1) “Rooms by nurse” should be visually dominant.
2) Per-room table is secondary.
3) Edit grid should remain responsive and not fight user input.

### Editing behavior
- Do not auto-normalize user input mid-keystroke.
- Parse time only after debounce or on blur/commit.
- Preserve the raw HH:MM string as entered.

### Derived columns
- Do not show internal `workload`, `effectiveLoad`, `randKey`, etc.
- Surface only user-entered fields + assigned nurse + ranks.

## Testing Strategy
### Engine tests (required)
- Phase membership and ordering:
  - discharge-only assigned first, stable order
  - under24 cs new→old then vag new→old, etc.
- No reassignment invariant:
  - Once a room is assigned, later phases must not move it.
- Soft constraint behavior:
  - With sufficient nurses, cs/bfi are distributed (no duplicates if avoidable).
  - With insufficient nurses, duplicates are allowed (penalty is soft).
- Determinism:
  - Same input yields byte-for-byte identical output.

### UI tests (recommended)
- Rapid cell edits do not cause value reversion.
- Debounce prevents excessive recomputes.
- Validation messages appear and clear appropriately.

## Agent Operating Guidelines
When implementing changes:
- Keep allocation logic inside the engine package; UI consumes it as a pure function.
- Preserve determinism; avoid non-stable sorts and random calls.
- Prefer explicit, documented tie-breakers for every sort.
- Maintain the sequential-phase semantics; never “optimize globally” in a way that violates phase priority.
- Keep “Rooms by nurse” prominent and easy to scan (room list with HH:MM and concise tag markers).

## Migration Checklist
- [x] Port data model and parsing (HH:MM + timezone anchored to today).
- [x] Port validation rules (blocking vs warnings).
- [x] Port deterministic hash for discharge ordering.
- [x] Port sequential phase allocator with no reassignment.
- [x] Port nurse scoring (balance + adjacency + cs/bfi penalties).
- [x] Implement debounced recompute and stable rendering in React.
- [x] Replicate outputs (rooms-by-nurse prominent; no derived columns).
- [x] Add engine unit tests covering phases, determinism, constraints.
