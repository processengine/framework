# ProcessEngine Operation Contract Schema Profile

Operation contract schemas (`inputSchema`, `responseSchema`, `errorSchema`) and a
process `processInputSchema` are **not** arbitrary JSON Schema. They are a bounded
profile for which the compiler proves producer→consumer compatibility statically.

The compiler **rejects** any keyword outside this profile at compile time. It does
not silently ignore constraints it cannot reason about — a schema that looks like
it constrains data but is not actually enforced would be a false guarantee.

This profile is a static *compatibility* check between the response/error one
operation produces and the input another operation consumes. It is not a runtime
validator: validating an external payload against a full API contract is the job
of the operation integration adapter, not the runtime.

## Supported keywords

| Keyword | Semantics used for compatibility |
| --- | --- |
| `type` | One of, or an array of, `string`, `number`, `integer`, `boolean`, `object`, `array`, `null`. Nullability is expressed by including `"null"` in a type array. A producer type set must be a subset of the consumer type set. |
| `enum` | Non-empty array of literal values. The producer enum must be a subset of the consumer enum. |
| `properties` | Map of property name → profile schema (recursive). |
| `required` | Array of property names. The producer must require every property the consumer requires, and each such property schema must itself be compatible. |
| `additionalProperties` | Boolean only. `false` marks a **closed object**: it rejects any property it does not declare. |
| `items` | A single profile schema (recursive) for array elements. |
| `title`, `description` | Pure annotations. Ignored for compatibility. |

Any other keyword — including `maxLength`, `minLength`, `pattern`, `format`,
`minimum`, `maximum`, `const`, `oneOf`, `anyOf`, `allOf`, `not`, `$ref`, `$defs`,
`patternProperties`, `minItems`, `maxItems`, tuple-form `items`, and object-form
`additionalProperties` — is rejected with a localized `FlowDefinitionError` that
names the offending keyword and its path.

## Compatibility algorithm (complete for this profile)

A producer schema `P` is compatible with a consumer schema `C` when all hold:

1. **Types**: if `C` declares `type`, `P` must declare `type` and `P`'s types are a
   subset of `C`'s types.
2. **Enum**: if `C` declares `enum`, `P` must declare `enum` and `P`'s values are a
   subset of `C`'s values.
3. **Required properties**: for every property required by `C`, `P` must require it,
   and `P`'s property schema must be compatible with `C`'s property schema.
4. **Closed objects**: if `C` is closed (`additionalProperties: false`), then `P`
   must also be closed and must not declare any property outside `C`'s declared
   property set. An open producer, or one declaring an extra property, is rejected.
5. **Arrays**: if `C` is an array with `items`, `P` must be an array whose `items`
   are compatible with `C`'s `items`.

`switch` steps additionally require the producer key property to be a required
`string` with a non-empty `enum`, and the switch `routes` to cover that enum
exactly (no missing and no unknown routes).

## Versioning

The grammar and this profile are versioned through the `@processengine/conductor`
package major/minor version and the versioned `$id` of the published flow schema,
backed by golden compatibility fixtures. There is deliberately **no** `dsl` or
`dslVersion` field inside the compact business flow JSON. A change that makes an
older fixture compile differently (different digest or normalized behavior) is a
breaking change and is treated as such.

## Non-goals

- No proof of inclusion for arbitrary JSON Schema.
- No runtime domain-payload processing, coercion, or hidden data mapping.
- No JSONPath, query language, or multi-result aggregation.
