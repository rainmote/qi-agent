---
name: creating-runtime-blueprints
description: Define, test, inspect, hot-update, stop, or remove a session-local runtime tool using DAO's bounded Clojure EDN Blueprint data language.
---

# Create runtime EDN Blueprints

Use a Blueprint when the user needs a small, session-local tool or stateful transformation and an audited built-in plugin does not already provide it.

## Safety and lifecycle

- A Blueprint is EDN data compiled by the host. It is not Clojure source and cannot resolve symbols, Vars, namespaces, classes, Java interop, files, processes, network, threads, `eval`, or `load-string`.
- Packages are immutable. Define a new package, run it, inspect it, then define another package under the same `pluginId` and use `update` to hot-swap.
- State is a bounded map owned by the logical plugin and survives successful package updates and rollback. Each tool call edits a draft and commits only after the program and output Schema succeed. State disappears on `undefine` or when the Creator Session closes.
- Tool names still obey Kernel single ownership. A Blueprint cannot replace a host tool or another plugin's tool.
- Runtime packages are experiments in the current Session. They do not become part of a Preset automatically.

## Source shape

Pass the complete EDN text in `runtime_plugin`'s `source` field:

```clojure
{:description "A stateful greeting tool."
 :initial-state {"calls" 0}
 :tools
 [{:name "greet_person"
   :description "Greet a person and return the call count."
   :parameters {:type "object"
                :properties {"name" {:type "string" :maxLength 100}}
                :required ["name"]
                :additionalProperties false}
   :output-schema {:type "object"
                   :properties {"message" {:type "string"}
                                "calls" {:type "integer"}}
                   :required ["message" "calls"]
                   :additionalProperties false}
   :program
   [:let [["next" [:+ [:state-get "calls" 0] 1]]]
    [:do
     [:state-put "calls" [:var "next"]]
     {:message [:str "Hello, " [:arg "name"] "!"]
      :calls [:var "next"]}]]}]}
```

Maps recursively evaluate their values. Ordinary strings, numbers, booleans, nil, and keywords are literals. Because vectors denote expressions, use `[:vector ...]` to construct a result vector and `[:literal [...]]` for literal vector data.

## Operators

- Context: `:arg`, `:var`, `:literal`, `:vector`, `:let`, `:if`, `:do`.
- Logic: `:=`, `:not=`, `:<`, `:<=`, `:>`, `:>=`, `:not`, `:and`, `:or`.
- Numbers: `:+`, `:-`, `:*`, `:/`, `:min`, `:max`, `:abs`.
- Strings: `:str`, `:lower`, `:upper`, `:trim`, `:join`, `:split`, `:replace`.
- Data: `:get`, `:contains?`, `:assoc`, `:dissoc`, `:merge`, `:conj`, `:count`, `:first`, `:last`, `:nth`, `:keys`, `:vals`, `:distinct`, `:sort`.
- Bounded collections: `[:map "item" collection body]`, `[:filter "item" collection predicate]`, and `[:reduce "acc" "item" initial collection body]`.
- State: `:state-get`, `:state-put`, `:state-delete`, `:state-snapshot`.

Variables are lexical. `:let` bindings are sequential, so a later binding may use an earlier one. Collection bodies can reference their declared binding with `[:var "name"]`.

## Workflow

1. Call `runtime_inspect` for the existing tools and avoid name collisions.
2. Call `runtime_plugin` with `action: "define"`, an `idPrefix`, `name`, `purpose`, and the complete `source`. Do not send `namespace` with `source`.
3. Call `run` with the returned `plugin-id` and `package-id`.
4. Call the generated tool with representative valid inputs and edge cases.
5. Use precise `inspect` with both ids to recover the exact source and diagnostics.
6. For a change, call `define` with the existing `pluginId` and new source, then `update` to the new package. If installation fails, the current pointer does not advance and the previous package is restored when possible.
7. Call `stop` to remove live tools while keeping package history, or `undefine` to remove the logical plugin and its state.
