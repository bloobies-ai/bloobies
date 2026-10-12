// Checks an event against packages/protocol/schema.json (the subset of JSON schema it uses: const, enum, type,
// required, min/max, $ref). Events posted to /event by other adapters go through this before the page sees them.
import fs from 'node:fs'

const schema = JSON.parse(fs.readFileSync(new URL('../protocol/schema.json', import.meta.url), 'utf8'))
const byType = new Map(schema.oneOf.map((s) => [s.properties.type.const, s]))

const deref = (s) => (s.$ref ? schema.$defs[s.$ref.split('/').pop()] : s)

function check(v, s) {
  s = deref(s)
  if ('const' in s) return v === s.const
  if (s.enum) return s.enum.includes(v)
  switch (s.type) {
    case 'string':
      return typeof v === 'string' && v.length >= (s.minLength ?? 0) && v.length <= (s.maxLength ?? Infinity) && (!s.pattern || new RegExp(s.pattern).test(v))
    case 'number':
    case 'integer':
      return (
        typeof v === 'number' &&
        Number.isFinite(v) &&
        (s.type === 'number' || Number.isInteger(v)) &&
        v >= (s.minimum ?? -Infinity) &&
        v <= (s.maximum ?? Infinity)
      )
    case 'boolean':
      return typeof v === 'boolean'
  }
  return true
}

/** Null if the event is valid, else what's wrong with it. */
export function validate(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object'
  const s = byType.get(e.type)
  if (!s) return `unknown type ${JSON.stringify(e.type)}`
  for (const k of s.required) if (e[k] === undefined) return `${e.type}: missing ${k}`
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined) continue
    const p = s.properties[k]
    if (!p) return `${e.type}: unknown field ${k}`
    if (!check(v, p)) return `${e.type}: bad ${k}`
  }
  return null
}

export const SCHEMA_VERSION = schema.version
