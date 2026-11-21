# API reference

A long reference document used to check that Rico stays responsive on large files. Every section is generated, but the structure mirrors what a real reference looks like.

## 1. Pull requests (part 1)

This section describes how Rico can fetch a pull request and the markdown files it changes. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server retries the input, then retries the result before it is returned to the browser.
  - Detail 1: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then forwards the result before it is returned to the browser.
  - Detail 2: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rejects the input, then retries the result before it is returned to the browser.
  - Detail 3: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by pull requests section 1. |
| `param2` | string | yes | Used by pull requests section 1. |
| `param3` | string | no | Used by pull requests section 1. |
| `param4` | string | no | Used by pull requests section 1. |

### Example

```json
{
  "section": 1,
  "ok": true,
  "items": [81, 79, 24, 13, 58]
}
```

> Note 1: results for pull requests may be cached for a short time; use the head commit to be exact.

## 2. Files (part 1)

This section describes how Rico can read a file at the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server caches the input, then rejects the result before it is returned to the browser.
  - Detail 4: values are never written to disk, and errors carry the upstream status.
- Step 2: the server normalizes the input, then validates the result before it is returned to the browser.
  - Detail 5: values are never written to disk, and errors carry the upstream status.
- Step 3: the server logs the input, then retries the result before it is returned to the browser.
  - Detail 6: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by files section 2. |
| `param2` | string | yes | Used by files section 2. |
| `param3` | string | no | Used by files section 2. |
| `param4` | string | no | Used by files section 2. |

### Example

```json
{
  "section": 2,
  "ok": true,
  "items": [84, 95, 79, 84, 21]
}
```

> Note 2: results for files may be cached for a short time; use the head commit to be exact.

## 3. Images (part 1)

This section describes how Rico can serve a relative image from the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server validates the input, then normalizes the result before it is returned to the browser.
  - Detail 7: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then validates the result before it is returned to the browser.
  - Detail 8: values are never written to disk, and errors carry the upstream status.
- Step 3: the server forwards the input, then forwards the result before it is returned to the browser.
  - Detail 9: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by images section 3. |
| `param2` | string | yes | Used by images section 3. |
| `param3` | string | no | Used by images section 3. |
| `param4` | string | no | Used by images section 3. |

### Example

```json
{
  "section": 3,
  "ok": true,
  "items": [77, 4, 60, 42, 57]
}
```

> Note 3: results for images may be cached for a short time; use the head commit to be exact.

## 4. Reviews (part 1)

This section describes how Rico can create a review with inline comments. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then forwards the result before it is returned to the browser.
  - Detail 10: values are never written to disk, and errors carry the upstream status.
- Step 2: the server caches the input, then retries the result before it is returned to the browser.
  - Detail 11: values are never written to disk, and errors carry the upstream status.
- Step 3: the server validates the input, then normalizes the result before it is returned to the browser.
  - Detail 12: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by reviews section 4. |
| `param2` | string | yes | Used by reviews section 4. |
| `param3` | string | no | Used by reviews section 4. |
| `param4` | string | no | Used by reviews section 4. |

### Example

```json
{
  "section": 4,
  "ok": true,
  "items": [59, 84, 36, 53, 71]
}
```

> Note 4: results for reviews may be cached for a short time; use the head commit to be exact.

## 5. Replies (part 1)

This section describes how Rico can reply to an existing thread. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then caches the result before it is returned to the browser.
  - Detail 13: values are never written to disk, and errors carry the upstream status.
- Step 2: the server rewrites the input, then forwards the result before it is returned to the browser.
  - Detail 14: values are never written to disk, and errors carry the upstream status.
- Step 3: the server caches the input, then validates the result before it is returned to the browser.
  - Detail 15: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by replies section 5. |
| `param2` | string | yes | Used by replies section 5. |
| `param3` | string | no | Used by replies section 5. |
| `param4` | string | no | Used by replies section 5. |

### Example

```json
{
  "section": 5,
  "ok": true,
  "items": [9, 73, 99, 14, 52]
}
```

> Note 5: results for replies may be cached for a short time; use the head commit to be exact.

## 6. Threads (part 1)

This section describes how Rico can group review comments into threads. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then caches the result before it is returned to the browser.
  - Detail 16: values are never written to disk, and errors carry the upstream status.
- Step 2: the server logs the input, then normalizes the result before it is returned to the browser.
  - Detail 17: values are never written to disk, and errors carry the upstream status.
- Step 3: the server validates the input, then validates the result before it is returned to the browser.
  - Detail 18: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by threads section 6. |
| `param2` | string | yes | Used by threads section 6. |
| `param3` | string | no | Used by threads section 6. |
| `param4` | string | no | Used by threads section 6. |

### Example

```json
{
  "section": 6,
  "ok": true,
  "items": [28, 27, 7, 61, 49]
}
```

> Note 6: results for threads may be cached for a short time; use the head commit to be exact.

## 7. Anchoring (part 1)

This section describes how Rico can map a selection to diff lines. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server logs the input, then logs the result before it is returned to the browser.
  - Detail 19: values are never written to disk, and errors carry the upstream status.
- Step 2: the server normalizes the input, then forwards the result before it is returned to the browser.
  - Detail 20: values are never written to disk, and errors carry the upstream status.
- Step 3: the server caches the input, then rewrites the result before it is returned to the browser.
  - Detail 21: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by anchoring section 7. |
| `param2` | string | yes | Used by anchoring section 7. |
| `param3` | string | no | Used by anchoring section 7. |
| `param4` | string | no | Used by anchoring section 7. |

### Example

```json
{
  "section": 7,
  "ok": true,
  "items": [12, 40, 43, 2, 53]
}
```

> Note 7: results for anchoring may be cached for a short time; use the head commit to be exact.

## 8. Clamping (part 1)

This section describes how Rico can fit a range to a single hunk. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then rejects the result before it is returned to the browser.
  - Detail 22: values are never written to disk, and errors carry the upstream status.
- Step 2: the server forwards the input, then normalizes the result before it is returned to the browser.
  - Detail 23: values are never written to disk, and errors carry the upstream status.
- Step 3: the server validates the input, then validates the result before it is returned to the browser.
  - Detail 24: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by clamping section 8. |
| `param2` | string | yes | Used by clamping section 8. |
| `param3` | string | no | Used by clamping section 8. |
| `param4` | string | no | Used by clamping section 8. |

### Example

```json
{
  "section": 8,
  "ok": true,
  "items": [60, 63, 23, 88, 72]
}
```

> Note 8: results for clamping may be cached for a short time; use the head commit to be exact.

## 9. Drafts (part 1)

This section describes how Rico can keep unsent comments in the browser. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then retries the result before it is returned to the browser.
  - Detail 25: values are never written to disk, and errors carry the upstream status.
- Step 2: the server forwards the input, then rejects the result before it is returned to the browser.
  - Detail 26: values are never written to disk, and errors carry the upstream status.
- Step 3: the server logs the input, then logs the result before it is returned to the browser.
  - Detail 27: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by drafts section 9. |
| `param2` | string | yes | Used by drafts section 9. |
| `param3` | string | no | Used by drafts section 9. |
| `param4` | string | no | Used by drafts section 9. |

### Example

```json
{
  "section": 9,
  "ok": true,
  "items": [15, 51, 54, 28, 1]
}
```

> Note 9: results for drafts may be cached for a short time; use the head commit to be exact.

## 10. Margins (part 1)

This section describes how Rico can place threads beside their text. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server caches the input, then caches the result before it is returned to the browser.
  - Detail 28: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then forwards the result before it is returned to the browser.
  - Detail 29: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rejects the input, then logs the result before it is returned to the browser.
  - Detail 30: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by margins section 10. |
| `param2` | string | yes | Used by margins section 10. |
| `param3` | string | no | Used by margins section 10. |
| `param4` | string | no | Used by margins section 10. |

### Example

```json
{
  "section": 10,
  "ok": true,
  "items": [78, 83, 74, 13, 6]
}
```

> Note 10: results for margins may be cached for a short time; use the head commit to be exact.

## 11. Pull requests (part 2)

This section describes how Rico can fetch a pull request and the markdown files it changes. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rejects the input, then forwards the result before it is returned to the browser.
  - Detail 31: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then caches the result before it is returned to the browser.
  - Detail 32: values are never written to disk, and errors carry the upstream status.
- Step 3: the server validates the input, then rewrites the result before it is returned to the browser.
  - Detail 33: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by pull requests section 11. |
| `param2` | string | yes | Used by pull requests section 11. |
| `param3` | string | no | Used by pull requests section 11. |
| `param4` | string | no | Used by pull requests section 11. |

### Example

```json
{
  "section": 11,
  "ok": true,
  "items": [38, 50, 10, 10, 12]
}
```

> Note 11: results for pull requests may be cached for a short time; use the head commit to be exact.

## 12. Files (part 2)

This section describes how Rico can read a file at the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then forwards the result before it is returned to the browser.
  - Detail 34: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then rewrites the result before it is returned to the browser.
  - Detail 35: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rewrites the input, then retries the result before it is returned to the browser.
  - Detail 36: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by files section 12. |
| `param2` | string | yes | Used by files section 12. |
| `param3` | string | no | Used by files section 12. |
| `param4` | string | no | Used by files section 12. |

### Example

```json
{
  "section": 12,
  "ok": true,
  "items": [17, 76, 62, 74, 18]
}
```

> Note 12: results for files may be cached for a short time; use the head commit to be exact.

## 13. Images (part 2)

This section describes how Rico can serve a relative image from the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server logs the input, then rejects the result before it is returned to the browser.
  - Detail 37: values are never written to disk, and errors carry the upstream status.
- Step 2: the server rejects the input, then caches the result before it is returned to the browser.
  - Detail 38: values are never written to disk, and errors carry the upstream status.
- Step 3: the server forwards the input, then forwards the result before it is returned to the browser.
  - Detail 39: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by images section 13. |
| `param2` | string | yes | Used by images section 13. |
| `param3` | string | no | Used by images section 13. |
| `param4` | string | no | Used by images section 13. |

### Example

```json
{
  "section": 13,
  "ok": true,
  "items": [93, 25, 21, 95, 81]
}
```

> Note 13: results for images may be cached for a short time; use the head commit to be exact.

## 14. Reviews (part 2)

This section describes how Rico can create a review with inline comments. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then logs the result before it is returned to the browser.
  - Detail 40: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then normalizes the result before it is returned to the browser.
  - Detail 41: values are never written to disk, and errors carry the upstream status.
- Step 3: the server logs the input, then validates the result before it is returned to the browser.
  - Detail 42: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by reviews section 14. |
| `param2` | string | yes | Used by reviews section 14. |
| `param3` | string | no | Used by reviews section 14. |
| `param4` | string | no | Used by reviews section 14. |

### Example

```json
{
  "section": 14,
  "ok": true,
  "items": [14, 14, 5, 66, 33]
}
```

> Note 14: results for reviews may be cached for a short time; use the head commit to be exact.

## 15. Replies (part 2)

This section describes how Rico can reply to an existing thread. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then logs the result before it is returned to the browser.
  - Detail 43: values are never written to disk, and errors carry the upstream status.
- Step 2: the server caches the input, then logs the result before it is returned to the browser.
  - Detail 44: values are never written to disk, and errors carry the upstream status.
- Step 3: the server retries the input, then caches the result before it is returned to the browser.
  - Detail 45: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by replies section 15. |
| `param2` | string | yes | Used by replies section 15. |
| `param3` | string | no | Used by replies section 15. |
| `param4` | string | no | Used by replies section 15. |

### Example

```json
{
  "section": 15,
  "ok": true,
  "items": [67, 23, 93, 9, 17]
}
```

> Note 15: results for replies may be cached for a short time; use the head commit to be exact.

## 16. Threads (part 2)

This section describes how Rico can group review comments into threads. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then retries the result before it is returned to the browser.
  - Detail 46: values are never written to disk, and errors carry the upstream status.
- Step 2: the server normalizes the input, then caches the result before it is returned to the browser.
  - Detail 47: values are never written to disk, and errors carry the upstream status.
- Step 3: the server forwards the input, then forwards the result before it is returned to the browser.
  - Detail 48: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by threads section 16. |
| `param2` | string | yes | Used by threads section 16. |
| `param3` | string | no | Used by threads section 16. |
| `param4` | string | no | Used by threads section 16. |

### Example

```json
{
  "section": 16,
  "ok": true,
  "items": [96, 3, 9, 35, 53]
}
```

> Note 16: results for threads may be cached for a short time; use the head commit to be exact.

## 17. Anchoring (part 2)

This section describes how Rico can map a selection to diff lines. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server retries the input, then forwards the result before it is returned to the browser.
  - Detail 49: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then validates the result before it is returned to the browser.
  - Detail 50: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rejects the input, then caches the result before it is returned to the browser.
  - Detail 51: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by anchoring section 17. |
| `param2` | string | yes | Used by anchoring section 17. |
| `param3` | string | no | Used by anchoring section 17. |
| `param4` | string | no | Used by anchoring section 17. |

### Example

```json
{
  "section": 17,
  "ok": true,
  "items": [48, 68, 74, 17, 12]
}
```

> Note 17: results for anchoring may be cached for a short time; use the head commit to be exact.

## 18. Clamping (part 2)

This section describes how Rico can fit a range to a single hunk. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rewrites the input, then rejects the result before it is returned to the browser.
  - Detail 52: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then rewrites the result before it is returned to the browser.
  - Detail 53: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rejects the input, then validates the result before it is returned to the browser.
  - Detail 54: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by clamping section 18. |
| `param2` | string | yes | Used by clamping section 18. |
| `param3` | string | no | Used by clamping section 18. |
| `param4` | string | no | Used by clamping section 18. |

### Example

```json
{
  "section": 18,
  "ok": true,
  "items": [3, 61, 46, 90, 40]
}
```

> Note 18: results for clamping may be cached for a short time; use the head commit to be exact.

## 19. Drafts (part 2)

This section describes how Rico can keep unsent comments in the browser. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server validates the input, then validates the result before it is returned to the browser.
  - Detail 55: values are never written to disk, and errors carry the upstream status.
- Step 2: the server normalizes the input, then retries the result before it is returned to the browser.
  - Detail 56: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then caches the result before it is returned to the browser.
  - Detail 57: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by drafts section 19. |
| `param2` | string | yes | Used by drafts section 19. |
| `param3` | string | no | Used by drafts section 19. |
| `param4` | string | no | Used by drafts section 19. |

### Example

```json
{
  "section": 19,
  "ok": true,
  "items": [41, 18, 10, 10, 58]
}
```

> Note 19: results for drafts may be cached for a short time; use the head commit to be exact.

## 20. Margins (part 2)

This section describes how Rico can place threads beside their text. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rewrites the input, then validates the result before it is returned to the browser.
  - Detail 58: values are never written to disk, and errors carry the upstream status.
- Step 2: the server rejects the input, then rewrites the result before it is returned to the browser.
  - Detail 59: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rewrites the input, then normalizes the result before it is returned to the browser.
  - Detail 60: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by margins section 20. |
| `param2` | string | yes | Used by margins section 20. |
| `param3` | string | no | Used by margins section 20. |
| `param4` | string | no | Used by margins section 20. |

### Example

```json
{
  "section": 20,
  "ok": true,
  "items": [88, 61, 10, 54, 4]
}
```

> Note 20: results for margins may be cached for a short time; use the head commit to be exact.

## 21. Pull requests (part 3)

This section describes how Rico can fetch a pull request and the markdown files it changes. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server retries the input, then validates the result before it is returned to the browser.
  - Detail 61: values are never written to disk, and errors carry the upstream status.
- Step 2: the server logs the input, then logs the result before it is returned to the browser.
  - Detail 62: values are never written to disk, and errors carry the upstream status.
- Step 3: the server validates the input, then normalizes the result before it is returned to the browser.
  - Detail 63: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by pull requests section 21. |
| `param2` | string | yes | Used by pull requests section 21. |
| `param3` | string | no | Used by pull requests section 21. |
| `param4` | string | no | Used by pull requests section 21. |

### Example

```json
{
  "section": 21,
  "ok": true,
  "items": [11, 12, 82, 15, 33]
}
```

> Note 21: results for pull requests may be cached for a short time; use the head commit to be exact.

## 22. Files (part 3)

This section describes how Rico can read a file at the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server logs the input, then rewrites the result before it is returned to the browser.
  - Detail 64: values are never written to disk, and errors carry the upstream status.
- Step 2: the server logs the input, then retries the result before it is returned to the browser.
  - Detail 65: values are never written to disk, and errors carry the upstream status.
- Step 3: the server retries the input, then retries the result before it is returned to the browser.
  - Detail 66: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by files section 22. |
| `param2` | string | yes | Used by files section 22. |
| `param3` | string | no | Used by files section 22. |
| `param4` | string | no | Used by files section 22. |

### Example

```json
{
  "section": 22,
  "ok": true,
  "items": [70, 11, 67, 97, 66]
}
```

> Note 22: results for files may be cached for a short time; use the head commit to be exact.

## 23. Images (part 3)

This section describes how Rico can serve a relative image from the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server validates the input, then caches the result before it is returned to the browser.
  - Detail 67: values are never written to disk, and errors carry the upstream status.
- Step 2: the server normalizes the input, then retries the result before it is returned to the browser.
  - Detail 68: values are never written to disk, and errors carry the upstream status.
- Step 3: the server validates the input, then forwards the result before it is returned to the browser.
  - Detail 69: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by images section 23. |
| `param2` | string | yes | Used by images section 23. |
| `param3` | string | no | Used by images section 23. |
| `param4` | string | no | Used by images section 23. |

### Example

```json
{
  "section": 23,
  "ok": true,
  "items": [90, 15, 64, 79, 85]
}
```

> Note 23: results for images may be cached for a short time; use the head commit to be exact.

## 24. Reviews (part 3)

This section describes how Rico can create a review with inline comments. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server retries the input, then caches the result before it is returned to the browser.
  - Detail 70: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then rewrites the result before it is returned to the browser.
  - Detail 71: values are never written to disk, and errors carry the upstream status.
- Step 3: the server caches the input, then rejects the result before it is returned to the browser.
  - Detail 72: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by reviews section 24. |
| `param2` | string | yes | Used by reviews section 24. |
| `param3` | string | no | Used by reviews section 24. |
| `param4` | string | no | Used by reviews section 24. |

### Example

```json
{
  "section": 24,
  "ok": true,
  "items": [87, 79, 26, 67, 22]
}
```

> Note 24: results for reviews may be cached for a short time; use the head commit to be exact.

## 25. Replies (part 3)

This section describes how Rico can reply to an existing thread. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rewrites the input, then retries the result before it is returned to the browser.
  - Detail 73: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then forwards the result before it is returned to the browser.
  - Detail 74: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rewrites the input, then logs the result before it is returned to the browser.
  - Detail 75: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by replies section 25. |
| `param2` | string | yes | Used by replies section 25. |
| `param3` | string | no | Used by replies section 25. |
| `param4` | string | no | Used by replies section 25. |

### Example

```json
{
  "section": 25,
  "ok": true,
  "items": [86, 33, 26, 82, 56]
}
```

> Note 25: results for replies may be cached for a short time; use the head commit to be exact.

## 26. Threads (part 3)

This section describes how Rico can group review comments into threads. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then forwards the result before it is returned to the browser.
  - Detail 76: values are never written to disk, and errors carry the upstream status.
- Step 2: the server logs the input, then forwards the result before it is returned to the browser.
  - Detail 77: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rewrites the input, then forwards the result before it is returned to the browser.
  - Detail 78: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by threads section 26. |
| `param2` | string | yes | Used by threads section 26. |
| `param3` | string | no | Used by threads section 26. |
| `param4` | string | no | Used by threads section 26. |

### Example

```json
{
  "section": 26,
  "ok": true,
  "items": [18, 18, 64, 45, 6]
}
```

> Note 26: results for threads may be cached for a short time; use the head commit to be exact.

## 27. Anchoring (part 3)

This section describes how Rico can map a selection to diff lines. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then caches the result before it is returned to the browser.
  - Detail 79: values are never written to disk, and errors carry the upstream status.
- Step 2: the server rejects the input, then normalizes the result before it is returned to the browser.
  - Detail 80: values are never written to disk, and errors carry the upstream status.
- Step 3: the server retries the input, then retries the result before it is returned to the browser.
  - Detail 81: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by anchoring section 27. |
| `param2` | string | yes | Used by anchoring section 27. |
| `param3` | string | no | Used by anchoring section 27. |
| `param4` | string | no | Used by anchoring section 27. |

### Example

```json
{
  "section": 27,
  "ok": true,
  "items": [36, 28, 53, 49, 81]
}
```

> Note 27: results for anchoring may be cached for a short time; use the head commit to be exact.

## 28. Clamping (part 3)

This section describes how Rico can fit a range to a single hunk. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server retries the input, then rewrites the result before it is returned to the browser.
  - Detail 82: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then rewrites the result before it is returned to the browser.
  - Detail 83: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then validates the result before it is returned to the browser.
  - Detail 84: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by clamping section 28. |
| `param2` | string | yes | Used by clamping section 28. |
| `param3` | string | no | Used by clamping section 28. |
| `param4` | string | no | Used by clamping section 28. |

### Example

```json
{
  "section": 28,
  "ok": true,
  "items": [36, 78, 6, 87, 91]
}
```

> Note 28: results for clamping may be cached for a short time; use the head commit to be exact.

## 29. Drafts (part 3)

This section describes how Rico can keep unsent comments in the browser. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server caches the input, then rewrites the result before it is returned to the browser.
  - Detail 85: values are never written to disk, and errors carry the upstream status.
- Step 2: the server caches the input, then validates the result before it is returned to the browser.
  - Detail 86: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rejects the input, then logs the result before it is returned to the browser.
  - Detail 87: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by drafts section 29. |
| `param2` | string | yes | Used by drafts section 29. |
| `param3` | string | no | Used by drafts section 29. |
| `param4` | string | no | Used by drafts section 29. |

### Example

```json
{
  "section": 29,
  "ok": true,
  "items": [59, 25, 4, 99, 35]
}
```

> Note 29: results for drafts may be cached for a short time; use the head commit to be exact.

## 30. Margins (part 3)

This section describes how Rico can place threads beside their text. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then rejects the result before it is returned to the browser.
  - Detail 88: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then normalizes the result before it is returned to the browser.
  - Detail 89: values are never written to disk, and errors carry the upstream status.
- Step 3: the server retries the input, then normalizes the result before it is returned to the browser.
  - Detail 90: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by margins section 30. |
| `param2` | string | yes | Used by margins section 30. |
| `param3` | string | no | Used by margins section 30. |
| `param4` | string | no | Used by margins section 30. |

### Example

```json
{
  "section": 30,
  "ok": true,
  "items": [81, 69, 84, 82, 48]
}
```

> Note 30: results for margins may be cached for a short time; use the head commit to be exact.

## 31. Pull requests (part 4)

This section describes how Rico can fetch a pull request and the markdown files it changes. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then forwards the result before it is returned to the browser.
  - Detail 91: values are never written to disk, and errors carry the upstream status.
- Step 2: the server forwards the input, then retries the result before it is returned to the browser.
  - Detail 92: values are never written to disk, and errors carry the upstream status.
- Step 3: the server caches the input, then rejects the result before it is returned to the browser.
  - Detail 93: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by pull requests section 31. |
| `param2` | string | yes | Used by pull requests section 31. |
| `param3` | string | no | Used by pull requests section 31. |
| `param4` | string | no | Used by pull requests section 31. |

### Example

```json
{
  "section": 31,
  "ok": true,
  "items": [92, 2, 97, 61, 69]
}
```

> Note 31: results for pull requests may be cached for a short time; use the head commit to be exact.

## 32. Files (part 4)

This section describes how Rico can read a file at the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server validates the input, then rejects the result before it is returned to the browser.
  - Detail 94: values are never written to disk, and errors carry the upstream status.
- Step 2: the server forwards the input, then caches the result before it is returned to the browser.
  - Detail 95: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rewrites the input, then rejects the result before it is returned to the browser.
  - Detail 96: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by files section 32. |
| `param2` | string | yes | Used by files section 32. |
| `param3` | string | no | Used by files section 32. |
| `param4` | string | no | Used by files section 32. |

### Example

```json
{
  "section": 32,
  "ok": true,
  "items": [51, 90, 29, 12, 53]
}
```

> Note 32: results for files may be cached for a short time; use the head commit to be exact.

## 33. Images (part 4)

This section describes how Rico can serve a relative image from the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server logs the input, then rejects the result before it is returned to the browser.
  - Detail 97: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then retries the result before it is returned to the browser.
  - Detail 98: values are never written to disk, and errors carry the upstream status.
- Step 3: the server forwards the input, then validates the result before it is returned to the browser.
  - Detail 99: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by images section 33. |
| `param2` | string | yes | Used by images section 33. |
| `param3` | string | no | Used by images section 33. |
| `param4` | string | no | Used by images section 33. |

### Example

```json
{
  "section": 33,
  "ok": true,
  "items": [49, 71, 73, 84, 65]
}
```

> Note 33: results for images may be cached for a short time; use the head commit to be exact.

## 34. Reviews (part 4)

This section describes how Rico can create a review with inline comments. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rewrites the input, then retries the result before it is returned to the browser.
  - Detail 100: values are never written to disk, and errors carry the upstream status.
- Step 2: the server rewrites the input, then forwards the result before it is returned to the browser.
  - Detail 101: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then normalizes the result before it is returned to the browser.
  - Detail 102: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by reviews section 34. |
| `param2` | string | yes | Used by reviews section 34. |
| `param3` | string | no | Used by reviews section 34. |
| `param4` | string | no | Used by reviews section 34. |

### Example

```json
{
  "section": 34,
  "ok": true,
  "items": [28, 32, 50, 12, 40]
}
```

> Note 34: results for reviews may be cached for a short time; use the head commit to be exact.

## 35. Replies (part 4)

This section describes how Rico can reply to an existing thread. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rewrites the input, then caches the result before it is returned to the browser.
  - Detail 103: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then rewrites the result before it is returned to the browser.
  - Detail 104: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then validates the result before it is returned to the browser.
  - Detail 105: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by replies section 35. |
| `param2` | string | yes | Used by replies section 35. |
| `param3` | string | no | Used by replies section 35. |
| `param4` | string | no | Used by replies section 35. |

### Example

```json
{
  "section": 35,
  "ok": true,
  "items": [57, 44, 71, 54, 99]
}
```

> Note 35: results for replies may be cached for a short time; use the head commit to be exact.

## 36. Threads (part 4)

This section describes how Rico can group review comments into threads. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server caches the input, then retries the result before it is returned to the browser.
  - Detail 106: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then forwards the result before it is returned to the browser.
  - Detail 107: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then logs the result before it is returned to the browser.
  - Detail 108: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by threads section 36. |
| `param2` | string | yes | Used by threads section 36. |
| `param3` | string | no | Used by threads section 36. |
| `param4` | string | no | Used by threads section 36. |

### Example

```json
{
  "section": 36,
  "ok": true,
  "items": [5, 23, 69, 43, 88]
}
```

> Note 36: results for threads may be cached for a short time; use the head commit to be exact.

## 37. Anchoring (part 4)

This section describes how Rico can map a selection to diff lines. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rejects the input, then retries the result before it is returned to the browser.
  - Detail 109: values are never written to disk, and errors carry the upstream status.
- Step 2: the server rejects the input, then retries the result before it is returned to the browser.
  - Detail 110: values are never written to disk, and errors carry the upstream status.
- Step 3: the server retries the input, then normalizes the result before it is returned to the browser.
  - Detail 111: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by anchoring section 37. |
| `param2` | string | yes | Used by anchoring section 37. |
| `param3` | string | no | Used by anchoring section 37. |
| `param4` | string | no | Used by anchoring section 37. |

### Example

```json
{
  "section": 37,
  "ok": true,
  "items": [98, 29, 57, 68, 72]
}
```

> Note 37: results for anchoring may be cached for a short time; use the head commit to be exact.

## 38. Clamping (part 4)

This section describes how Rico can fit a range to a single hunk. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server caches the input, then rejects the result before it is returned to the browser.
  - Detail 112: values are never written to disk, and errors carry the upstream status.
- Step 2: the server caches the input, then caches the result before it is returned to the browser.
  - Detail 113: values are never written to disk, and errors carry the upstream status.
- Step 3: the server logs the input, then forwards the result before it is returned to the browser.
  - Detail 114: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by clamping section 38. |
| `param2` | string | yes | Used by clamping section 38. |
| `param3` | string | no | Used by clamping section 38. |
| `param4` | string | no | Used by clamping section 38. |

### Example

```json
{
  "section": 38,
  "ok": true,
  "items": [39, 19, 70, 68, 35]
}
```

> Note 38: results for clamping may be cached for a short time; use the head commit to be exact.

## 39. Drafts (part 4)

This section describes how Rico can keep unsent comments in the browser. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server retries the input, then forwards the result before it is returned to the browser.
  - Detail 115: values are never written to disk, and errors carry the upstream status.
- Step 2: the server logs the input, then normalizes the result before it is returned to the browser.
  - Detail 116: values are never written to disk, and errors carry the upstream status.
- Step 3: the server validates the input, then logs the result before it is returned to the browser.
  - Detail 117: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by drafts section 39. |
| `param2` | string | yes | Used by drafts section 39. |
| `param3` | string | no | Used by drafts section 39. |
| `param4` | string | no | Used by drafts section 39. |

### Example

```json
{
  "section": 39,
  "ok": true,
  "items": [4, 69, 6, 67, 52]
}
```

> Note 39: results for drafts may be cached for a short time; use the head commit to be exact.

## 40. Margins (part 4)

This section describes how Rico can place threads beside their text. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then retries the result before it is returned to the browser.
  - Detail 118: values are never written to disk, and errors carry the upstream status.
- Step 2: the server normalizes the input, then rejects the result before it is returned to the browser.
  - Detail 119: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then retries the result before it is returned to the browser.
  - Detail 120: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by margins section 40. |
| `param2` | string | yes | Used by margins section 40. |
| `param3` | string | no | Used by margins section 40. |
| `param4` | string | no | Used by margins section 40. |

### Example

```json
{
  "section": 40,
  "ok": true,
  "items": [53, 52, 35, 32, 61]
}
```

> Note 40: results for margins may be cached for a short time; use the head commit to be exact.

## 41. Pull requests (part 5)

This section describes how Rico can fetch a pull request and the markdown files it changes. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server retries the input, then rejects the result before it is returned to the browser.
  - Detail 121: values are never written to disk, and errors carry the upstream status.
- Step 2: the server rewrites the input, then logs the result before it is returned to the browser.
  - Detail 122: values are never written to disk, and errors carry the upstream status.
- Step 3: the server retries the input, then rewrites the result before it is returned to the browser.
  - Detail 123: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by pull requests section 41. |
| `param2` | string | yes | Used by pull requests section 41. |
| `param3` | string | no | Used by pull requests section 41. |
| `param4` | string | no | Used by pull requests section 41. |

### Example

```json
{
  "section": 41,
  "ok": true,
  "items": [14, 25, 54, 80, 4]
}
```

> Note 41: results for pull requests may be cached for a short time; use the head commit to be exact.

## 42. Files (part 5)

This section describes how Rico can read a file at the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server caches the input, then rejects the result before it is returned to the browser.
  - Detail 124: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then validates the result before it is returned to the browser.
  - Detail 125: values are never written to disk, and errors carry the upstream status.
- Step 3: the server forwards the input, then rejects the result before it is returned to the browser.
  - Detail 126: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by files section 42. |
| `param2` | string | yes | Used by files section 42. |
| `param3` | string | no | Used by files section 42. |
| `param4` | string | no | Used by files section 42. |

### Example

```json
{
  "section": 42,
  "ok": true,
  "items": [30, 2, 88, 37, 42]
}
```

> Note 42: results for files may be cached for a short time; use the head commit to be exact.

## 43. Images (part 5)

This section describes how Rico can serve a relative image from the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rewrites the input, then forwards the result before it is returned to the browser.
  - Detail 127: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then normalizes the result before it is returned to the browser.
  - Detail 128: values are never written to disk, and errors carry the upstream status.
- Step 3: the server retries the input, then normalizes the result before it is returned to the browser.
  - Detail 129: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by images section 43. |
| `param2` | string | yes | Used by images section 43. |
| `param3` | string | no | Used by images section 43. |
| `param4` | string | no | Used by images section 43. |

### Example

```json
{
  "section": 43,
  "ok": true,
  "items": [66, 80, 33, 92, 26]
}
```

> Note 43: results for images may be cached for a short time; use the head commit to be exact.

## 44. Reviews (part 5)

This section describes how Rico can create a review with inline comments. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server logs the input, then validates the result before it is returned to the browser.
  - Detail 130: values are never written to disk, and errors carry the upstream status.
- Step 2: the server logs the input, then logs the result before it is returned to the browser.
  - Detail 131: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rejects the input, then forwards the result before it is returned to the browser.
  - Detail 132: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by reviews section 44. |
| `param2` | string | yes | Used by reviews section 44. |
| `param3` | string | no | Used by reviews section 44. |
| `param4` | string | no | Used by reviews section 44. |

### Example

```json
{
  "section": 44,
  "ok": true,
  "items": [81, 69, 82, 28, 68]
}
```

> Note 44: results for reviews may be cached for a short time; use the head commit to be exact.

## 45. Replies (part 5)

This section describes how Rico can reply to an existing thread. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then rejects the result before it is returned to the browser.
  - Detail 133: values are never written to disk, and errors carry the upstream status.
- Step 2: the server forwards the input, then rewrites the result before it is returned to the browser.
  - Detail 134: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rejects the input, then rewrites the result before it is returned to the browser.
  - Detail 135: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by replies section 45. |
| `param2` | string | yes | Used by replies section 45. |
| `param3` | string | no | Used by replies section 45. |
| `param4` | string | no | Used by replies section 45. |

### Example

```json
{
  "section": 45,
  "ok": true,
  "items": [78, 41, 25, 28, 25]
}
```

> Note 45: results for replies may be cached for a short time; use the head commit to be exact.

## 46. Threads (part 5)

This section describes how Rico can group review comments into threads. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then rejects the result before it is returned to the browser.
  - Detail 136: values are never written to disk, and errors carry the upstream status.
- Step 2: the server forwards the input, then rejects the result before it is returned to the browser.
  - Detail 137: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then caches the result before it is returned to the browser.
  - Detail 138: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by threads section 46. |
| `param2` | string | yes | Used by threads section 46. |
| `param3` | string | no | Used by threads section 46. |
| `param4` | string | no | Used by threads section 46. |

### Example

```json
{
  "section": 46,
  "ok": true,
  "items": [50, 13, 56, 54, 70]
}
```

> Note 46: results for threads may be cached for a short time; use the head commit to be exact.

## 47. Anchoring (part 5)

This section describes how Rico can map a selection to diff lines. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rejects the input, then forwards the result before it is returned to the browser.
  - Detail 139: values are never written to disk, and errors carry the upstream status.
- Step 2: the server logs the input, then validates the result before it is returned to the browser.
  - Detail 140: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then forwards the result before it is returned to the browser.
  - Detail 141: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by anchoring section 47. |
| `param2` | string | yes | Used by anchoring section 47. |
| `param3` | string | no | Used by anchoring section 47. |
| `param4` | string | no | Used by anchoring section 47. |

### Example

```json
{
  "section": 47,
  "ok": true,
  "items": [73, 88, 46, 47, 15]
}
```

> Note 47: results for anchoring may be cached for a short time; use the head commit to be exact.

## 48. Clamping (part 5)

This section describes how Rico can fit a range to a single hunk. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rewrites the input, then forwards the result before it is returned to the browser.
  - Detail 142: values are never written to disk, and errors carry the upstream status.
- Step 2: the server normalizes the input, then retries the result before it is returned to the browser.
  - Detail 143: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then validates the result before it is returned to the browser.
  - Detail 144: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by clamping section 48. |
| `param2` | string | yes | Used by clamping section 48. |
| `param3` | string | no | Used by clamping section 48. |
| `param4` | string | no | Used by clamping section 48. |

### Example

```json
{
  "section": 48,
  "ok": true,
  "items": [5, 98, 71, 79, 66]
}
```

> Note 48: results for clamping may be cached for a short time; use the head commit to be exact.

## 49. Drafts (part 5)

This section describes how Rico can keep unsent comments in the browser. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server retries the input, then rejects the result before it is returned to the browser.
  - Detail 145: values are never written to disk, and errors carry the upstream status.
- Step 2: the server forwards the input, then rejects the result before it is returned to the browser.
  - Detail 146: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then forwards the result before it is returned to the browser.
  - Detail 147: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by drafts section 49. |
| `param2` | string | yes | Used by drafts section 49. |
| `param3` | string | no | Used by drafts section 49. |
| `param4` | string | no | Used by drafts section 49. |

### Example

```json
{
  "section": 49,
  "ok": true,
  "items": [23, 21, 37, 87, 13]
}
```

> Note 49: results for drafts may be cached for a short time; use the head commit to be exact.

## 50. Margins (part 5)

This section describes how Rico can place threads beside their text. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server validates the input, then rejects the result before it is returned to the browser.
  - Detail 148: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then normalizes the result before it is returned to the browser.
  - Detail 149: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then rewrites the result before it is returned to the browser.
  - Detail 150: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by margins section 50. |
| `param2` | string | yes | Used by margins section 50. |
| `param3` | string | no | Used by margins section 50. |
| `param4` | string | no | Used by margins section 50. |

### Example

```json
{
  "section": 50,
  "ok": true,
  "items": [51, 60, 55, 66, 46]
}
```

> Note 50: results for margins may be cached for a short time; use the head commit to be exact.

## 51. Pull requests (part 6)

This section describes how Rico can fetch a pull request and the markdown files it changes. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server logs the input, then forwards the result before it is returned to the browser.
  - Detail 151: values are never written to disk, and errors carry the upstream status.
- Step 2: the server rewrites the input, then validates the result before it is returned to the browser.
  - Detail 152: values are never written to disk, and errors carry the upstream status.
- Step 3: the server validates the input, then forwards the result before it is returned to the browser.
  - Detail 153: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by pull requests section 51. |
| `param2` | string | yes | Used by pull requests section 51. |
| `param3` | string | no | Used by pull requests section 51. |
| `param4` | string | no | Used by pull requests section 51. |

### Example

```json
{
  "section": 51,
  "ok": true,
  "items": [24, 53, 59, 47, 95]
}
```

> Note 51: results for pull requests may be cached for a short time; use the head commit to be exact.

## 52. Files (part 6)

This section describes how Rico can read a file at the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rewrites the input, then logs the result before it is returned to the browser.
  - Detail 154: values are never written to disk, and errors carry the upstream status.
- Step 2: the server forwards the input, then rejects the result before it is returned to the browser.
  - Detail 155: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then validates the result before it is returned to the browser.
  - Detail 156: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by files section 52. |
| `param2` | string | yes | Used by files section 52. |
| `param3` | string | no | Used by files section 52. |
| `param4` | string | no | Used by files section 52. |

### Example

```json
{
  "section": 52,
  "ok": true,
  "items": [42, 11, 91, 81, 52]
}
```

> Note 52: results for files may be cached for a short time; use the head commit to be exact.

## 53. Images (part 6)

This section describes how Rico can serve a relative image from the head commit. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server forwards the input, then rewrites the result before it is returned to the browser.
  - Detail 157: values are never written to disk, and errors carry the upstream status.
- Step 2: the server caches the input, then caches the result before it is returned to the browser.
  - Detail 158: values are never written to disk, and errors carry the upstream status.
- Step 3: the server normalizes the input, then rejects the result before it is returned to the browser.
  - Detail 159: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by images section 53. |
| `param2` | string | yes | Used by images section 53. |
| `param3` | string | no | Used by images section 53. |
| `param4` | string | no | Used by images section 53. |

### Example

```json
{
  "section": 53,
  "ok": true,
  "items": [52, 18, 43, 69, 89]
}
```

> Note 53: results for images may be cached for a short time; use the head commit to be exact.

## 54. Reviews (part 6)

This section describes how Rico can create a review with inline comments. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rewrites the input, then logs the result before it is returned to the browser.
  - Detail 160: values are never written to disk, and errors carry the upstream status.
- Step 2: the server rejects the input, then logs the result before it is returned to the browser.
  - Detail 161: values are never written to disk, and errors carry the upstream status.
- Step 3: the server forwards the input, then rejects the result before it is returned to the browser.
  - Detail 162: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by reviews section 54. |
| `param2` | string | yes | Used by reviews section 54. |
| `param3` | string | no | Used by reviews section 54. |
| `param4` | string | no | Used by reviews section 54. |

### Example

```json
{
  "section": 54,
  "ok": true,
  "items": [10, 44, 39, 61, 13]
}
```

> Note 54: results for reviews may be cached for a short time; use the head commit to be exact.

## 55. Replies (part 6)

This section describes how Rico can reply to an existing thread. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server validates the input, then rewrites the result before it is returned to the browser.
  - Detail 163: values are never written to disk, and errors carry the upstream status.
- Step 2: the server validates the input, then forwards the result before it is returned to the browser.
  - Detail 164: values are never written to disk, and errors carry the upstream status.
- Step 3: the server caches the input, then caches the result before it is returned to the browser.
  - Detail 165: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by replies section 55. |
| `param2` | string | yes | Used by replies section 55. |
| `param3` | string | no | Used by replies section 55. |
| `param4` | string | no | Used by replies section 55. |

### Example

```json
{
  "section": 55,
  "ok": true,
  "items": [44, 28, 85, 52, 73]
}
```

> Note 55: results for replies may be cached for a short time; use the head commit to be exact.

## 56. Threads (part 6)

This section describes how Rico can group review comments into threads. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server rejects the input, then normalizes the result before it is returned to the browser.
  - Detail 166: values are never written to disk, and errors carry the upstream status.
- Step 2: the server logs the input, then retries the result before it is returned to the browser.
  - Detail 167: values are never written to disk, and errors carry the upstream status.
- Step 3: the server forwards the input, then normalizes the result before it is returned to the browser.
  - Detail 168: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by threads section 56. |
| `param2` | string | yes | Used by threads section 56. |
| `param3` | string | no | Used by threads section 56. |
| `param4` | string | no | Used by threads section 56. |

### Example

```json
{
  "section": 56,
  "ok": true,
  "items": [98, 51, 74, 3, 15]
}
```

> Note 56: results for threads may be cached for a short time; use the head commit to be exact.

## 57. Anchoring (part 6)

This section describes how Rico can map a selection to diff lines. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then forwards the result before it is returned to the browser.
  - Detail 169: values are never written to disk, and errors carry the upstream status.
- Step 2: the server caches the input, then retries the result before it is returned to the browser.
  - Detail 170: values are never written to disk, and errors carry the upstream status.
- Step 3: the server logs the input, then validates the result before it is returned to the browser.
  - Detail 171: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by anchoring section 57. |
| `param2` | string | yes | Used by anchoring section 57. |
| `param3` | string | no | Used by anchoring section 57. |
| `param4` | string | no | Used by anchoring section 57. |

### Example

```json
{
  "section": 57,
  "ok": true,
  "items": [98, 26, 83, 49, 2]
}
```

> Note 57: results for anchoring may be cached for a short time; use the head commit to be exact.

## 58. Clamping (part 6)

This section describes how Rico can fit a range to a single hunk. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then caches the result before it is returned to the browser.
  - Detail 172: values are never written to disk, and errors carry the upstream status.
- Step 2: the server caches the input, then caches the result before it is returned to the browser.
  - Detail 173: values are never written to disk, and errors carry the upstream status.
- Step 3: the server rewrites the input, then logs the result before it is returned to the browser.
  - Detail 174: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by clamping section 58. |
| `param2` | string | yes | Used by clamping section 58. |
| `param3` | string | no | Used by clamping section 58. |
| `param4` | string | no | Used by clamping section 58. |

### Example

```json
{
  "section": 58,
  "ok": true,
  "items": [67, 73, 13, 82, 57]
}
```

> Note 58: results for clamping may be cached for a short time; use the head commit to be exact.

## 59. Drafts (part 6)

This section describes how Rico can keep unsent comments in the browser. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server normalizes the input, then validates the result before it is returned to the browser.
  - Detail 175: values are never written to disk, and errors carry the upstream status.
- Step 2: the server logs the input, then rejects the result before it is returned to the browser.
  - Detail 176: values are never written to disk, and errors carry the upstream status.
- Step 3: the server logs the input, then retries the result before it is returned to the browser.
  - Detail 177: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by drafts section 59. |
| `param2` | string | yes | Used by drafts section 59. |
| `param3` | string | no | Used by drafts section 59. |
| `param4` | string | no | Used by drafts section 59. |

### Example

```json
{
  "section": 59,
  "ok": true,
  "items": [22, 64, 70, 79, 77]
}
```

> Note 59: results for drafts may be cached for a short time; use the head commit to be exact.

## 60. Margins (part 6)

This section describes how Rico can place threads beside their text. It is one of many sections that follow the same layout, so reviewers can practise commenting across headings, lists, tables and code.

### Behaviour

- Step 1: the server validates the input, then logs the result before it is returned to the browser.
  - Detail 178: values are never written to disk, and errors carry the upstream status.
- Step 2: the server retries the input, then logs the result before it is returned to the browser.
  - Detail 179: values are never written to disk, and errors carry the upstream status.
- Step 3: the server caches the input, then logs the result before it is returned to the browser.
  - Detail 180: values are never written to disk, and errors carry the upstream status.

### Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `param1` | string | yes | Used by margins section 60. |
| `param2` | string | yes | Used by margins section 60. |
| `param3` | string | no | Used by margins section 60. |
| `param4` | string | no | Used by margins section 60. |

### Example

```json
{
  "section": 60,
  "ok": true,
  "items": [77, 40, 47, 68, 37]
}
```

> Note 60: results for margins may be cached for a short time; use the head commit to be exact.

