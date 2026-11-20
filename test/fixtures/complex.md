# Complex document

An intro paragraph that is hard wrapped across
several source lines so that the word-position
refinement has something to chew on, with `inline code`
and a [link](https://example.com/a/b) in the middle.

## Lists

- Top level item with a long sentence that
  wraps onto a second source line
  - Nested item one
  - Nested item two that also wraps
    onto another line
    1. Deeply nested ordered item
    2. Another ordered item
- Second top level item
- Third top level item with **bold text** and _emphasis_

1. First ordered
2. Second ordered that is
   hard wrapped too
3. Third ordered

## Code

```js
const alpha = 1;

const beta = 2;
function gamma() {
  return alpha + beta;
}
```

Text between code blocks.

~~~
plain tilde fence
second line
~~~

    indented code block
    with two lines

## Quote and table

> A quoted paragraph that wraps
> across two source lines.
>
> Second quoted paragraph.

| Name | Value |
|------|-------|
| one  | 1     |
| two  | 2     |
| three | 3    |

### Heading with `code` and trailing text

Final paragraph with an image ![alt text](img/x.png) and a very long line that just goes on and on and on without any wrapping at all so it stays on one source line.
