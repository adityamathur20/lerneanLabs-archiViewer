/**
 * What the Floors panel decides, with no DOM: whether every detected floor has
 * been decided, what is wrong with an edit, and what is sent.
 *
 * Detection only proposes. A floor becomes real when the user approves it, and
 * the run starts only when every floor has been decided and one is approved.
 */
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
export const ELEVATION_RANGE = { min: -100, max: 2000 };
export const NAME_MAX = 80;

/**
 * @param {{id: string, name: string, elevation_ft: number, elevation_source: string, confidence?: number}[]} floors
 * @param {Record<string, boolean>} decisions  floor id -> approved (absent = undecided)
 * @param {Record<string, {name?: string, elevation?: string}>} edits  what the user typed
 */
export function evaluateFloors(floors, decisions, edits) {
  const rows = floors.map((floor) => {
    const edit = edits[floor.id] ?? {};
    const name = edit.name !== undefined ? edit.name.trim() : floor.name;
    const elevationText = edit.elevation !== undefined ? edit.elevation.trim() : "";
    let problem = null;
    let elevation = floor.elevation_ft;
    if (!name) problem = "Give the floor a name.";
    else if (name.length > NAME_MAX) problem = `A name is at most ${NAME_MAX} characters.`;
    if (!problem && elevationText !== "") {
      const value = PLAIN_NUMBER.test(elevationText) ? Number(elevationText) : NaN;
      if (!Number.isFinite(value)) problem = "The elevation must be a number of feet.";
      else if (value < ELEVATION_RANGE.min || value > ELEVATION_RANGE.max) {
        problem = `The elevation must be between ${ELEVATION_RANGE.min} and ${ELEVATION_RANGE.max} ft.`;
      } else elevation = value;
    }
    return {
      id: floor.id, name, elevation, problem,
      source: floor.elevation_source,
      decision: decisions[floor.id] ?? null,
      unnamed: /^Unnamed plan/.test(floor.name),
      confidence: floor.confidence ?? null,
    };
  });

  const undecided = rows.filter((r) => r.decision === null).map((r) => r.id);
  const approved = rows.filter((r) => r.decision === true).length;
  const blocked = rows.find((r) => r.decision === true && r.problem);
  let message = "";
  if (undecided.length) message = `Decide every floor: approve or disapprove ${undecided.length} more.`;
  else if (!approved) message = "Approve at least one floor.";
  else if (blocked) message = `${blocked.name}: ${blocked.problem}`;

  const canStart = !undecided.length && approved > 0 && !blocked;
  const payload = !canStart ? null : {
    floors: floors.map((floor, i) => {
      const row = rows[i];
      const sent = { id: floor.id, approved: row.decision === true };
      if (row.decision === true) {
        if (row.name !== floor.name) sent.name = row.name;
        if (row.elevation !== floor.elevation_ft) sent.elevation_ft = row.elevation;
      }
      return sent;
    }),
  };
  return { rows, undecided, approved, canStart, message, payload };
}
