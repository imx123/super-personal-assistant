/**
 * A bounded matcher for the patterns an external subscription may carry.
 *
 * A pattern comes from an operator or from an Agent, and a pattern that backtracks may take the control plane's thread
 * with it: `(a+)+$` against a long run of `a` costs more time than the control plane can spend, and a timeout cannot help
 * because the matcher runs inside the control plane's own thread.
 *
 * So the matcher is not the platform's. It is a Thompson simulation: the pattern becomes a state machine and every state
 * is stepped in parallel, so a match costs `length of the text × number of states` and never more. There is no backtracking
 * to bound, and the subset is small on purpose:
 *
 * - literals, `.`, the shorthands `\d \w \s` and their negations, and `[...]` with ranges;
 * - groups `(...)` and alternation `|`;
 * - the quantifiers `*`, `+` and `?`;
 * - the anchors `^` and `$`, at the ends of the pattern only.
 *
 * What is not in the subset is refused rather than approximated: a backreference, a lookahead, a lazy or possessive
 * quantifier and a counted quantifier are all errors, and a pattern that cannot be compiled never runs.
 */

/** One range of code units a character class covers. */
interface Range {
  lo: number
  hi: number
}

/** A set of characters: a list of ranges, and whether the set is their complement. */
interface CharSet {
  negated: boolean
  ranges: Range[]
}

/** The parsed shape of a pattern. */
type Node =
  | { kind: 'empty' }
  | { kind: 'chars'; set: CharSet }
  | { kind: 'concat'; parts: Node[] }
  | { kind: 'alt'; options: Node[] }
  | { kind: 'repeat'; part: Node; min: number; max: number }
  | { kind: 'assertStart' }
  | { kind: 'assertEnd' }

/** One instruction of the compiled machine. */
type Inst =
  | { op: 'char'; set: CharSet; next: number }
  | { op: 'split'; next: number; other: number }
  | { op: 'assertStart'; next: number }
  | { op: 'assertEnd'; next: number }
  | { op: 'match'; next: number }

/** A dangling field of an instruction that a later step fills in. */
interface Slot {
  index: number
  field: 'next' | 'other'
}

/** A piece of the machine: where it starts, and which fields are still open. */
interface Fragment {
  start: number
  outs: Slot[]
}

/** A compiled pattern: the machine, where it starts, and where it ends. */
export interface SafePattern {
  program: Inst[]
  start: number
  match: number
}

/** The longest pattern the matcher accepts. */
export const MAX_PATTERN_LENGTH = 256
/** The longest text a pattern is matched against; a longer value is cut before the match. */
export const MAX_PATTERN_TEXT = 256
/** The most instructions a compiled pattern may hold. */
const MAX_PROGRAM_SIZE = 1024

/**
 * A pattern that is not in the subset.
 *
 * The message says what is wrong, so an operator who wrote a lookahead learns that the matcher does not do one — and
 * never that the pattern was silently reinterpreted.
 */
export class PatternError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'PatternError'
  }
}

/** Whether a code unit belongs to a set. */
function belongs(set: CharSet, code: number): boolean {
  let inside = false
  for (const range of set.ranges) {
    if (code >= range.lo && code <= range.hi) {
      inside = true
      break
    }
  }
  return set.negated ? !inside : inside
}

/** The set of the digits. */
const DIGITS: Range[] = [{ lo: 48, hi: 57 }]
/** The set of the word characters: the letters, the digits and the underscore. */
const WORD: Range[] = [{ lo: 48, hi: 57 }, { lo: 65, hi: 90 }, { lo: 95, hi: 95 }, { lo: 97, hi: 122 }]
/** The set of the whitespace. */
const SPACE: Range[] = [{ lo: 9, hi: 13 }, { lo: 32, hi: 32 }]

/**
 * The parser of the subset.
 *
 * It reads the pattern once and refuses at the first thing it does not know. A pattern it accepted is a pattern the
 * compiler can turn into a machine.
 */
class Parser {
  private index = 0

  constructor(private readonly source: string) {}

  /** Parse the whole pattern. */
  parse(): Node {
    const node = this.parseAlternation()
    if (this.index < this.source.length) {
      // The only thing that may follow a whole pattern is a closing bracket of an enclosing group.
      throw new PatternError(`unexpected ${JSON.stringify(this.source[this.index])}`)
    }
    return node
  }

  /** `a|b|c`: every option of the alternation. */
  private parseAlternation(): Node {
    const options: Node[] = [this.parseConcat()]
    while (this.peek() === '|') {
      this.index += 1
      options.push(this.parseConcat())
    }
    return options.length === 1 ? options[0]! : { kind: 'alt', options }
  }

  /** `abc`: the pieces of one branch of an alternation. */
  private parseConcat(): Node {
    const parts: Node[] = []
    while (this.index < this.source.length && this.peek() !== '|' && this.peek() !== ')') {
      parts.push(this.parseQuantified())
    }
    if (parts.length === 0) return { kind: 'empty' }
    return parts.length === 1 ? parts[0]! : { kind: 'concat', parts }
  }

  /** One atom and the quantifier that may follow it. */
  private parseQuantified(): Node {
    const atom = this.parseAtom()
    const quantifier = this.peek()
    if (quantifier !== '*' && quantifier !== '+' && quantifier !== '?') return atom
    this.index += 1
    const lazy = this.peek()
    if (lazy === '?' || lazy === '+') {
      throw new PatternError('a lazy or possessive quantifier is not supported')
    }
    if (quantifier === '*') return { kind: 'repeat', part: atom, min: 0, max: Infinity }
    if (quantifier === '+') return { kind: 'repeat', part: atom, min: 1, max: Infinity }
    return { kind: 'repeat', part: atom, min: 0, max: 1 }
  }

  /** One atom: a literal, a class, a group, an anchor or an escape. */
  private parseAtom(): Node {
    const character = this.source[this.index]
    if (character === undefined) throw new PatternError('the pattern ended early')
    if (character === '(') {
      if (this.source[this.index + 1] === '?') throw new PatternError('a group modifier is not supported')
      this.index += 1
      const inner = this.parseAlternation()
      if (this.peek() !== ')') throw new PatternError('a group must close with )')
      this.index += 1
      return inner
    }
    if (character === '[') return { kind: 'chars', set: this.parseClass() }
    if (character === '.') {
      this.index += 1
      // Any character but the line break.
      return { kind: 'chars', set: { negated: true, ranges: [{ lo: 10, hi: 10 }] } }
    }
    if (character === '^') {
      if (this.index !== 0) throw new PatternError('the anchor ^ is only allowed at the start of a pattern')
      this.index += 1
      return { kind: 'assertStart' }
    }
    if (character === '$') {
      if (this.index !== this.source.length - 1) {
        throw new PatternError('the anchor $ is only allowed at the end of a pattern')
      }
      this.index += 1
      return { kind: 'assertEnd' }
    }
    if (character === '{' || character === '}') {
      throw new PatternError('a counted quantifier is not supported')
    }
    if (character === '*' || character === '+' || character === '?') {
      throw new PatternError('a quantifier must follow an atom')
    }
    if (character === '\\') return this.parseEscape()
    this.index += 1
    return { kind: 'chars', set: { negated: false, ranges: [{ lo: character.charCodeAt(0), hi: character.charCodeAt(0) }] } }
  }

  /** `\d`, `\n`, `\.` and the rest: one set of characters. */
  private parseEscape(): Node {
    this.index += 1
    const escaped = this.source[this.index]
    if (escaped === undefined) throw new PatternError('a pattern must not end with a backslash')
    this.index += 1
    const shorthand = SHORTHANDS[escaped]
    if (shorthand !== undefined) {
      // `\D`, `\W` and `\S` are the complements of their lowercase form.
      return { kind: 'chars', set: { negated: shorthand.negated, ranges: shorthand.ranges } }
    }
    if (escaped >= '0' && escaped <= '9') throw new PatternError('a backreference is not supported')
    if (escaped === 'k') throw new PatternError('a named backreference is not supported')
    if (escaped === 'x' || escaped === 'u') throw new PatternError('a hexadecimal escape is not supported')
    if (escaped === 'b' || escaped === 'B') throw new PatternError('a word boundary is not supported')
    const code = escaped.charCodeAt(0)
    return { kind: 'chars', set: { negated: false, ranges: [{ lo: code, hi: code }] } }
  }

  /** `[abc]`, `[^a-z]` and the shorthands inside a class. */
  private parseClass(): CharSet {
    this.index += 1
    let negated = false
    if (this.peek() === '^') {
      negated = true
      this.index += 1
    }
    const ranges: Range[] = []
    let first = true
    for (;;) {
      if (this.index >= this.source.length) throw new PatternError('a character class must close with ]')
      const character = this.source[this.index]!
      if (character === ']' && !first) {
        this.index += 1
        break
      }
      first = false
      const low = this.parseClassAtom()
      if (this.peek() === '-' && this.source[this.index + 1] !== undefined && this.source[this.index + 1] !== ']') {
        this.index += 1
        const high = this.parseClassAtom()
        // A range names two characters: a shorthand has no single end, so it may not be one.
        if (!low.literal || !high.literal) throw new PatternError('a character range must name two characters')
        if (high.ranges[0]!.lo < low.ranges[0]!.lo) throw new PatternError('a character range runs backwards')
        ranges.push({ lo: low.ranges[0]!.lo, hi: high.ranges[0]!.hi })
      } else {
        ranges.push(...low.ranges)
      }
    }
    return { negated, ranges }
  }

  /** One atom of a character class: a literal, an escape or a shorthand. */
  private parseClassAtom(): { ranges: Range[]; literal: boolean } {
    const character = this.source[this.index]
    if (character === undefined) throw new PatternError('a character class must close with ]')
    if (character === '\\') {
      this.index += 1
      const escaped = this.source[this.index]
      if (escaped === undefined) throw new PatternError('a pattern must not end with a backslash')
      this.index += 1
      const shorthand = SHORTHANDS[escaped]
      if (shorthand !== undefined) {
        if (shorthand.negated) throw new PatternError('a negated shorthand is not supported inside a character class')
        return { ranges: shorthand.ranges, literal: false }
      }
      if (escaped >= '0' && escaped <= '9') throw new PatternError('a backreference is not supported')
      const code = escaped.charCodeAt(0)
      return { ranges: [{ lo: code, hi: code }], literal: true }
    }
    this.index += 1
    const code = character.charCodeAt(0)
    return { ranges: [{ lo: code, hi: code }], literal: true }
  }

  /** The character at the cursor, or the end of the pattern. */
  private peek(): string {
    return this.source[this.index] ?? ''
  }
}

/** The shorthands the subset knows, with the ranges they cover. */
const SHORTHANDS: Record<string, { ranges: Range[]; negated: boolean }> = {
  d: { ranges: DIGITS, negated: false },
  D: { ranges: DIGITS, negated: true },
  w: { ranges: WORD, negated: false },
  W: { ranges: WORD, negated: true },
  s: { ranges: SPACE, negated: false },
  S: { ranges: SPACE, negated: true },
  n: { ranges: [{ lo: 10, hi: 10 }], negated: false },
  r: { ranges: [{ lo: 13, hi: 13 }], negated: false },
  t: { ranges: [{ lo: 9, hi: 9 }], negated: false },
}

/**
 * The compiler of the subset.
 *
 * It turns the parsed shape into a machine whose states are stepped in parallel, so the machine never backtracks and
 * never grows a stack.
 */
class Compiler {
  readonly program: Inst[] = []

  /** Compile a whole pattern. */
  compile(node: Node): SafePattern {
    const fragment = this.compileNode(node)
    const match = this.emit({ op: 'match', next: -1 })
    this.patch(fragment.outs, match)
    return { program: this.program, start: fragment.start, match }
  }

  /** Compile one node. */
  private compileNode(node: Node): Fragment {
    switch (node.kind) {
      case 'empty': {
        const index = this.emit({ op: 'match', next: -1 })
        return { start: index, outs: [] }
      }
      case 'chars': {
        const index = this.emit({ op: 'char', set: node.set, next: -1 })
        return { start: index, outs: [{ index, field: 'next' }] }
      }
      case 'assertStart': {
        const index = this.emit({ op: 'assertStart', next: -1 })
        return { start: index, outs: [{ index, field: 'next' }] }
      }
      case 'assertEnd': {
        const index = this.emit({ op: 'assertEnd', next: -1 })
        return { start: index, outs: [{ index, field: 'next' }] }
      }
      case 'concat': {
        let fragment: Fragment | undefined
        for (const part of node.parts) {
          const next = this.compileNode(part)
          if (fragment === undefined) {
            fragment = next
            continue
          }
          this.patch(fragment.outs, next.start)
          fragment = { start: fragment.start, outs: next.outs }
        }
        return fragment ?? this.compileNode({ kind: 'empty' })
      }
      case 'alt': {
        let fragment = this.compileNode(node.options[0]!)
        for (const option of node.options.slice(1)) {
          const other = this.compileNode(option)
          const index = this.emit({ op: 'split', next: -1, other: -1 })
          // The instruction is read back from the program, so it is narrowed to the split it is before its own fields are
          // written: the program holds several kinds of instruction, and only a split has a second branch.
          const split = this.program[index]!
          if (split.op !== 'split') throw new PatternError('the pattern is too large to compile')
          split.next = fragment.start
          split.other = other.start
          fragment = { start: index, outs: [...fragment.outs, ...other.outs] }
        }
        return fragment
      }
      case 'repeat':
        return this.compileRepeat(node)
    }
  }

  /** Compile the three quantifiers the subset knows. */
  private compileRepeat(node: { part: Node; min: number; max: number }): Fragment {
    if (node.min === 0 && node.max === Infinity) {
      // `x*`: the body may run again, or the loop may end.
      const index = this.emit({ op: 'split', next: -1, other: -1 })
      const body = this.compileNode(node.part)
      this.patch(body.outs, index)
      this.program[index]!.next = body.start
      return { start: index, outs: [{ index, field: 'other' }] }
    }
    if (node.min === 1 && node.max === Infinity) {
      // `x+`: the body runs once, and then it may run again.
      const first = this.compileNode(node.part)
      const loop = this.compileRepeat({ part: node.part, min: 0, max: Infinity })
      this.patch(first.outs, loop.start)
      return { start: first.start, outs: loop.outs }
    }
    if (node.min === 0 && node.max === 1) {
      // `x?`: the body may run, or it may be skipped.
      const index = this.emit({ op: 'split', next: -1, other: -1 })
      const body = this.compileNode(node.part)
      this.program[index]!.next = body.start
      return { start: index, outs: [{ index, field: 'other' }, ...body.outs] }
    }
    throw new PatternError('this quantifier is not supported')
  }

  /** Add one instruction. */
  private emit(instruction: Inst): number {
    if (this.program.length >= MAX_PROGRAM_SIZE) throw new PatternError('the pattern is too large to compile')
    this.program.push(instruction)
    return this.program.length - 1
  }

  /** Point every open field at the instruction that follows. */
  private patch(slots: Slot[], target: number): void {
    for (const slot of slots) {
      const instruction = this.program[slot.index]!
      if (instruction.op === 'split') {
        if (slot.field === 'other') instruction.other = target
        else instruction.next = target
        continue
      }
      instruction.next = target
    }
  }
}

/**
 * Compile a pattern into a machine.
 *
 * The pattern is checked before it is read: a long one is refused without being parsed, so a caller cannot make the
 * control plane work for a pattern that was never going to run.
 */
export function compilePattern(pattern: string): SafePattern {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new PatternError(`a pattern may hold at most ${MAX_PATTERN_LENGTH} characters`)
  }
  return new Compiler().compile(new Parser(pattern).parse())
}

/**
 * Whether a text matches a compiled pattern.
 *
 * The match is a search: the pattern may match anywhere in the text, and the anchors `^` and `$` say where it may not.
 * Every state is stepped in parallel, so the cost is the length of the text times the number of states — never more, and
 * never a stack that grows with the text.
 */
export function matchesPattern(pattern: SafePattern, text: string): boolean {
  const subject = text.length > MAX_PATTERN_TEXT ? text.slice(0, MAX_PATTERN_TEXT) : text
  const program = pattern.program
  /**
   * Follow one thread through the instructions that cost nothing, and say whether the pattern ended.
   *
   * The threads that wait for a character are collected in `list`, and the `seen` set keeps one instruction from being
   * followed twice in the same step, so the work of a step is bounded by the number of instructions.
   */
  const add = (index: number, list: number[], position: number, seen: Set<number>): boolean => {
    if (index < 0 || seen.has(index)) return false
    seen.add(index)
    const instruction = program[index]!
    switch (instruction.op) {
      case 'char':
        list.push(index)
        return false
      case 'match':
        return true
      case 'assertStart':
        return position === 0 ? add(instruction.next, list, position, seen) : false
      case 'assertEnd':
        return position === subject.length ? add(instruction.next, list, position, seen) : false
      case 'split': {
        const first = add(instruction.next, list, position, seen)
        const second = add(instruction.other, list, position, seen)
        return first || second
      }
    }
  }
  // `threads` holds the instructions that are ready to consume the character at `position`.
  let threads: number[] = []
  if (add(pattern.start, threads, 0, new Set<number>())) return true
  for (let position = 0; position < subject.length; position += 1) {
    const next: number[] = []
    const seen = new Set<number>()
    for (const index of threads) {
      const instruction = program[index]!
      if (instruction.op !== 'char') continue
      if (!belongs(instruction.set, subject.charCodeAt(position))) continue
      if (add(instruction.next, next, position + 1, seen)) return true
    }
    // A match may also begin at the next position, so the pattern is a search and not a match at the front only.
    if (add(pattern.start, next, position + 1, seen)) return true
    if (next.length === 0) break
    threads = next
  }
  return false
}

/** The compiled patterns, kept so a rule is not compiled again for every event. */
const compiled = new Map<string, SafePattern>()

/**
 * Whether a text matches a pattern, compiling it the first time it is used.
 *
 * A pattern that is not in the subset never runs: the caller is told why, and nothing is matched.
 */
export function safeMatches(pattern: string, text: string): boolean {
  let machine = compiled.get(pattern)
  if (machine === undefined) {
    machine = compilePattern(pattern)
    // The cache is small on purpose: a deployment has few rules, and a pattern that changes often is not a rule.
    if (compiled.size >= 64) compiled.clear()
    compiled.set(pattern, machine)
  }
  return matchesPattern(machine, text)
}

/**
 * Whether a pattern is one the matcher can run.
 *
 * A caller uses this to refuse a pattern when it is written rather than when it is first matched.
 */
export function isSafePattern(pattern: string): boolean {
  try {
    compilePattern(pattern)
    return true
  } catch {
    return false
  }
}
