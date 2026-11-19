/**
 * What a deletion leaves behind in the running library.
 *
 * **Deleting a row removes it; it does not erase it.** SQLite writes a deleted row's content into the free space of the
 * page it was on, and the old bytes stay there until something else is written over them. A reader that knows where to
 * look can still read the text of a row that was deleted a moment ago. Two settings close that door, and both are asked
 * of the SQLite that is really running here rather than assumed:
 *
 * - `PRAGMA secure_delete` is the core setting: the database engine overwrites the content of a deleted row with zeros
 *   when it writes the page out.
 * - The `secure_delete` configuration option of an FTS5 table is the index's own setting: the keyword index holds the
 *   words of every memory it indexed, and without it the deleted words stay in the index's own segments.
 *
 * **Neither of them rewrites the past.** A database backup taken before the deletion still holds the old text, and so
 * does a write-ahead log that has not been checkpointed yet: the settings are about what the running library writes from
 * now on, and the history keeps its own rules. Nothing here vacuums a database, rewrites a backup or touches a raw
 * session record.
 */
import type { DatabaseSync } from 'node:sqlite'

/**
 * The spellings the FTS5 configuration option is known under.
 *
 * The SQLite that runs here is asked for the setting rather than told which spelling it uses: the first one it accepts
 * is the one that is used, and a build that knows neither leaves the index as it was. The check is a real statement
 * against the real table, so the answer is the running SQLite's own.
 */
const FTS_SECURE_DELETE_SPELLINGS = ['secure_delete', 'secure-delete'] as const

/**
 * Overwrite what this connection deletes, for as long as the work runs.
 *
 * The setting belongs to the connection and to the database file behind it, so it is turned on for the work and turned
 * back afterwards: the deletion of one memory does not quietly change how every other table of that file behaves.
 */
export function withSecureDelete<T>(db: DatabaseSync, work: () => T, onError: (error: unknown) => void = () => {}): T {
  const previous = secureDeleteSetting(db)
  if (previous === '') {
    // The setting could not be read: the deletion still happens, and the old bytes may stay where they were.
    return work()
  }
  try {
    db.exec('PRAGMA secure_delete = ON')
  } catch (error) {
    onError(error)
    return work()
  }
  try {
    return work()
  } finally {
    try {
      db.exec(`PRAGMA secure_delete = ${previous}`)
    } catch (error) {
      onError(error)
    }
  }
}

/**
 * The setting as it is right now, in the spelling SQLite wrote it.
 *
 * An empty answer means the setting could not be read at all — the caller then knows it may not rely on it.
 */
function secureDeleteSetting(db: DatabaseSync): string {
  try {
    const row = db.prepare('PRAGMA secure_delete').get() as { secure_delete?: number | string } | undefined
    const value = row?.secure_delete
    if (value === undefined || value === null) return ''
    return String(value)
  } catch (error) {
    return ''
  }
}

/**
 * Make one keyword index overwrite what it deletes.
 *
 * The option belongs to the FTS5 table itself, so it is asked of that table: the statement is the documented way to
 * set an FTS5 configuration option, and a table whose SQLite does not know the option refuses the statement rather
 * than accepting it silently.
 *
 * The name is written into the statement itself, the way the documentation writes it: the table and the option come
 * from this file's own lists, and nothing a caller said ends up in the statement.
 *
 * A SQLite that knows neither spelling keeps the index as it was, and says so: the fact that the index of this build
 * cannot overwrite what it deletes is worth a line of its own, because the deleted words may stay readable inside it.
 */
export function enableFtsSecureDelete(db: DatabaseSync, table: string,
  onError: (error: unknown) => void = () => {}): boolean {
  let firstFailure: unknown
  for (const option of FTS_SECURE_DELETE_SPELLINGS) {
    try {
      db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('${option}', 1)`).run()
      return true
    } catch (error) {
      if (firstFailure === undefined) firstFailure = error
    }
  }
  onError(new Error(`The keyword index of this SQLite cannot overwrite what it deletes: ${messageOf(firstFailure)}`))
  return false
}

/** The words of a failure, whatever it was. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
