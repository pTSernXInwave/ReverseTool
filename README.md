
# Lunar Build Tools

This project has 2 scripts:
- `extractor.js`: extract assets from `<project>.html`
- `encode.js`: rebuild a new HTML by re-encoding assets from extracted folders

## Requirements
- [Node.js 18+](https://nodejs.org/en/download) (recommended)
- Run commands in this project folder

## File naming convention
- Build file: `<project>.html`
- Extracted folder: `<out-root>/<project>.extracted`
- Rebuilt file: `<out-root>/new_<project>.html`

Example project name: `example`
- build: `example.html`
- extracted: `_out/example.extracted`
- rebuilt: `_out/new_example.html`

## 1) Extract assets

### Command
```bash
node extractor.js <project-name> [out-root]
```

### Parameters
- `<project-name>`: required, without `.html`
- `[out-root]`: optional output root folder
  - default: `_out`

### Examples
```bash
node extractor.js example
```
- Reads: `example.html`
- Writes: `_out/example.extracted`

```bash
node extractor.js example out
```
- Reads: `example.html`
- Writes: `out/example.extracted`

### What extractor outputs
Inside `<out-root>/<project>.extracted`:
- `jsons/`
- `blobs/`
- `sounds/`
- `inline-assets/`
- `summary.json`

## 2) Re-encode and rebuild

### Command
```bash
node encode.js <project-name> [out-root]
```

### Parameters
- `<project-name>`: required, without `.html`
- `[out-root]`: optional output root folder
  - default: `_out`

### Examples
```bash
node encode.js example
```
- Reads build: `example.html`
- Reads extracted: `_out/example.extracted`
- Writes rebuilt: `_out/new_example.html`

```bash
node encode.js example out
```
- Reads build: `example.html`
- Reads extracted: `out/example.extracted`
- Writes rebuilt: `out/new_example.html`

## Encode behavior
- Re-encodes and replaces assets from:
  - `inline-assets/`
  - `sounds/`
- Ignores:
  - `jsons/`
  - `blobs/`
- Keeps original build file and extracted folder unchanged.

## Typical workflow
```bash
node extractor.js example
# edit files in _out/example.extracted/inline-assets and/or sounds
node encode.js example
```

Result:
- New build at `_out/new_example.html`
