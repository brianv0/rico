# Diagrams

An intro paragraph before the first diagram.

```d2
browser -> server: request
server -> github: api call
```

Text between diagrams.

```d2
a -> {
```

```d2
x: {link: "javascript:window.__pwned = 1"; icon: https://icons.terrastruct.com/essentials%2F092-graph%20bar.svg}
x -> y
```

A closing paragraph after the diagrams.

## Mermaid

```mermaid
flowchart LR
  A[Browser] -->|select| B(Server)
  B --> C{GitHub}
```

```mermaid
sequenceDiagram
  participant U as User
  participant R as Rico
  U->>R: select text
  R-->>U: comment box
```

```mermaid
flowchart LR
  A -->
```

## Graphviz

```dot
digraph G {
  rankdir=LR;
  Browser -> Server [label="select"];
  Server -> GitHub;
  subgraph cluster_gh { label="GitHub"; GitHub; API }
  GitHub -> API;
}
```

```graphviz
graph { a -- b -- c; b -- d }
```

```dot
digraph { a -> }
```
