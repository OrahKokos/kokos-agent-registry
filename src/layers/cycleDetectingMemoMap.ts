/**
 * Runtime circular-dependency detection for `Layer` graphs.
 *
 * Effect v4 performs **no** cycle analysis of the layer graph. Sharing is
 * implemented entirely inside `Layer.MemoMap`, which maps a *layer value*
 * (object identity) to a `{ deferred, scope, observers }` entry. The first
 * requester installs the entry and builds the layer; everybody else awaits that
 * entry's `Deferred`. A dependency cycle therefore degenerates into a fiber
 * awaiting a `Deferred` that only it can complete: the fiber suspends forever
 * and no error is ever produced.
 *
 * This module keeps the existing sharing semantics (it delegates entry
 * storage to a base `MemoMap`, so `observers` refcounting and scope ownership
 * are unchanged) and adds two bookkeeping structures on top:
 *
 * - `builder`: which fiber currently owns the in-progress entry per layer,
 * - `stacks` / `waitingOn`: the per-fiber build stack and wait-for edges used
 *   to prove that a wait would close a cycle.
 *
 * The check runs *before* the await is installed, so a cycle surfaces as a
 * `CircularLayerDependency` defect instead of a hang.
 *
 * ## What is preserved
 *
 * - Sharing is still keyed by layer *identity*: structurally identical but
 *   distinct `Layer` values are built separately, one value required twice is
 *   built once.
 * - A legitimately concurrent waiter (a sibling branch of `Layer.mergeAll`
 *   awaiting the same in-progress entry from another fiber) is not a cycle:
 *   the wait-for walk finds no path back to the waiter, so it simply awaits.
 * - A failing build still completes the entry's `Deferred`, so concurrent
 *   waiters observe the same failure.
 *
 * ## Limits
 *
 * - Only memoized nodes (`fromBuildMemo`: `Layer.effect`, `Layer.sync`,
 *   `Layer.suspend`, ...) are pushed on the build stack. A cycle built purely
 *   from `fromBuild` nodes (`mergeAll`, `provide`, `flatMap`) never installs a
 *   pending entry and recurses unboundedly (livelock, not deadlock); promote
 *   the loop's leaves to `Layer.fromBuildMemo` if you need coverage.
 * - Builds against an already closed `Scope` are instrumented (the base map
 *   refuses to install an entry and builds unshared, but the stack is still
 *   tracked), so re-entrancy there is still reported.
 * - Detection only covers builds threaded through *this* memo map. A nested
 *   `Layer.build` forks the ambient `Layer.CurrentMemoMap` and is not
 *   instrumented.
 * - A cycle that closes through user-level `Deferred`s is invisible; that is
 *   fiber-level deadlock, not layer re-entrancy.
 * - Layer values are anonymous: use {@link annotate} on the leaves (the
 *   `Layer.effect` / `Layer.fromBuildMemo` values) to get readable paths.
 *
 * @example
 * import { Effect, Layer } from "effect"
 * import { annotate, provide } from "./cycleDetectingMemoMap.ts"
 *
 * const AppLayer = annotate("App")(Layer.mergeAll(UserLayer, DbLayer))
 * Effect.runPromiseExit(program.pipe(provide(AppLayer)))
 * // Failure(Cause([Die(CircularLayerDependency: Circular layer dependency: User -> Db -> User)]))
 */
import { Data, Deferred, Effect, Layer, Scope } from "effect"
import { dual } from "effect/Function"

const MemoMapTypeId = "~effect/Layer/MemoMap"

const names = new WeakMap<object, string>()
const identifiers = new WeakMap<object, number>()
let nextIdentifier = 0

const labelOf = (layer: Layer.Layer<any, any, any>): string => {
  const name = names.get(layer)
  if (name !== undefined) return name
  let identifier = identifiers.get(layer)
  if (identifier === undefined) {
    identifier = ++nextIdentifier
    identifiers.set(layer, identifier)
  }
  return `layer#${identifier}`
}

/**
 * Attaches a human readable name to a layer value so it can appear in cycle
 * paths. Annotate the memoized leaves (`Layer.effect`, `Layer.fromBuildMemo`,
 * `Layer.suspend`), since those are the values stored in the `MemoMap`.
 */
export const annotate =
  (name: string) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, E, R> => {
    names.set(layer, name)
    return layer
  }

/**
 * Defect raised when a layer build would wait on itself, either directly (same
 * fiber re-entrancy) or transitively (a wait-for cycle across fibers).
 */
export class CircularLayerDependency extends Data.TaggedError("CircularLayerDependency")<{
  /** Layers involved, in wait order, starting at the re-entered layer. */
  readonly path: ReadonlyArray<string>
  /** Fibers forming the wait-for cycle (a single entry for same-fiber cycles). */
  readonly fibers: ReadonlyArray<number>
  readonly message: string
}> {}

const cycleError = (path: ReadonlyArray<string>, fibers: ReadonlyArray<number>): CircularLayerDependency =>
  new CircularLayerDependency({ path, fibers, message: `Circular layer dependency: ${path.join(" -> ")}` })

type AnyLayer = Layer.Layer<any, any, any>

/**
 * Decorates a `MemoMap` with cycle detection while preserving its sharing,
 * refcounting and scope ownership semantics.
 */
export const makeCycleDetectingMemoMap = (
  base: Layer.MemoMap = Layer.makeMemoMapUnsafe()
): Layer.MemoMap => {
  /** layer -> fiber currently executing its build */
  const builder = new Map<AnyLayer, number>()
  /** fiber -> layers it is currently building (innermost last) */
  const stacks = new Map<number, Array<AnyLayer>>()
  /** waiter fiber -> fiber it is blocked on */
  const waitingOn = new Map<number, number>()
  /** fiber -> layer it is blocked on (diagnostics only) */
  const awaiting = new Map<number, AnyLayer>()

  /** Walks the wait-for graph; a path back to `waiter` proves a deadlock. */
  const detect = (waiter: number, owner: number, layer: AnyLayer): CircularLayerDependency | undefined => {
    if (owner === waiter) {
      const stack = stacks.get(waiter) ?? []
      const start = stack.findIndex((entry) => entry === layer)
      const path = (start === -1 ? stack : stack.slice(start)).map(labelOf)
      return cycleError([...path, labelOf(layer)], [waiter])
    }
    const fibers: Array<number> = []
    const seen = new Set<number>()
    let current: number | undefined = owner
    while (current !== undefined && !seen.has(current)) {
      if (current === waiter) {
        const layers = [layer, ...fibers.map((fiber) => awaiting.get(fiber))]
        return cycleError(
          layers.filter((entry): entry is AnyLayer => entry !== undefined).map(labelOf),
          [waiter, ...fibers]
        )
      }
      seen.add(current)
      fibers.push(current)
      current = waitingOn.get(current)
    }
    return undefined
  }

  /** Marks `layer` as built by `fiberId` for the duration of `effect`. */
  const enter = (fiberId: number, layer: AnyLayer, effect: Effect.Effect<any, any, any>) =>
    Effect.suspend(() => {
      builder.set(layer, fiberId)
      const stack = stacks.get(fiberId)
      if (stack === undefined) stacks.set(fiberId, [layer])
      else stack.push(layer)
      return Effect.onExit(effect, () =>
        Effect.sync(() => {
          builder.delete(layer)
          const current = stacks.get(fiberId)
          if (current !== undefined && current[current.length - 1] === layer) current.pop()
          if (current !== undefined && current.length === 0) stacks.delete(fiberId)
        }))
    })

  /** Records the wait edge for the duration of `effect`, or dies on a cycle. */
  const awaitEntry = <A, E>(
    fiberId: number,
    owner: number,
    layer: AnyLayer,
    effect: Effect.Effect<A, E, any>
  ): Effect.Effect<A, E, any> => {
    const problem = detect(fiberId, owner, layer)
    if (problem !== undefined) return Effect.die(problem)
    waitingOn.set(fiberId, owner)
    awaiting.set(fiberId, layer)
    return Effect.ensuring(
      effect,
      Effect.sync(() => {
        waitingOn.delete(fiberId)
        awaiting.delete(fiberId)
      })
    )
  }

  const self: Layer.MemoMap = {
    [MemoMapTypeId]: MemoMapTypeId,
    get: (layer, scope) => {
      const effect = base.get(layer, scope)
      if (effect === undefined) return undefined
      const owner = builder.get(layer)
      if (owner === undefined) return effect
      return Effect.suspend(() =>
        Effect.flatMap(Effect.fiberId, (fiberId) => awaitEntry(fiberId, owner, layer, effect)))
    },
    getOrElseMemoize: (layer, scope, build) =>
      Effect.suspend(() =>
        Effect.flatMap(Effect.fiberId, (fiberId) => {
          const owner = builder.get(layer)
          // Pass `self` (not the base map handed to the callback) so nested
          // memoized layers are instrumented too.
          const acquire = base.getOrElseMemoize(layer, scope, (_memoMap, entryScope) =>
            enter(fiberId, layer, build(self, entryScope)))
          return owner === undefined ? acquire : awaitEntry(fiberId, owner, layer, acquire)
        }))
  }

  return self
}

/**
 * `Effect.provide` equivalent that installs a cycle-detecting memo map for the
 * layer construction (same build order and scope semantics as the original).
 */
export const provide = dual<
  <ROut, E2, RIn>(
    layer: Layer.Layer<ROut, E2, RIn>
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>>,
  <A, E, R, ROut, E2, RIn>(
    self: Effect.Effect<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>
  ) => Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>>
>(2, (self: Effect.Effect<any, any, any>, layer: Layer.Layer<any, any, any>) =>
  Effect.scopedWith((scope: Scope.Scope) =>
    Effect.flatMap(
      Layer.buildWithMemoMap(layer, makeCycleDetectingMemoMap(), scope),
      (context) => Effect.provideContext(self, context)
    )
  ))
