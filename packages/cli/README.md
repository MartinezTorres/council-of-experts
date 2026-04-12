# @council-of-experts/cli

Interactive CLI for `council-of-experts`.

This package is a thin demo shell around the core runtime:
- it loads agent config from JSON
- it opens an in-memory council session
- it exposes a small built-in file inspection toolset (`ls`, `cat`)

It is intentionally ephemeral. There is no persistence between runs.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Create a config file

Copy `config.example.json` to `config.json` and adjust the engine URL/model.

### 3. Run the CLI

```bash
npm run dev -- config.json
```

Or build and run:

```bash
npm run build
npm start -- config.json
```

## Local Provider Demo

This repository now includes a runnable example config for the local provider you
validated:

- config: [config.local-provider.example.json](/opt/repos/util/neural-storm/council-of-experts/packages/cli/config.local-provider.example.json)
- provider: `http://localhost:5815`
- model: `Qwen3.5-27B`

From the repository root:

```bash
npm run demo:local-cli
```

Then try these flows in the CLI:

```text
/mode council
Review how this repository separates the core runtime from the CLI shell.

/mode oracle
Give one concrete recommendation for the next refactor.

/messages all
/status
```

The example config sets `workspaceRoot` relative to the config file, so it
always points back to the repository root instead of depending on your current
shell directory.

## Commands

- `/mode <open|council|oracle>` changes the active council mode
- `/status` prints the current council status snapshot
- `/messages [public|private]` prints stored council messages
- `/clear` resets the in-memory session
- `/help` shows command help
- `/quit` exits

## Built-In Tools

- `ls` lists files or directories relative to the configured workspace root
- `cat` reads a UTF-8 text file relative to the configured workspace root

The CLI automatically expands those tool names into full tool definitions before
passing them to the runtime.

## Configuration

The config file uses this shape:

```json
{
  "workspaceRoot": "../..",
  "runtime": {
    "initialMode": "open"
  },
  "agents": [
    {
      "id": "repo-analyst",
      "name": "Repo Analyst",
      "icon": "📦",
      "summary": "Inspects repository structure and architecture",
      "systemPrompt": "You inspect codebases carefully. Use ls to explore directories and cat to read relevant files before answering.",
      "tools": ["ls", "cat"],
      "engine": {
        "provider": "http://localhost:1234",
        "model": "your-model-name",
        "settings": {
          "api_key": "",
          "temperature": 0.2
        },
        "timeoutMs": 60000
      }
    }
  ]
}
```

`workspaceRoot` is resolved relative to the config file location, not the
current shell directory.

## Architecture

- `src/index.ts` wires config, tool host, and the CLI session together
- `src/session.ts` owns the in-memory council lifecycle for the interactive shell
- `src/tools.ts` defines the built-in CLI tools and their host implementation
- `src/chat.ts` is just the readline user interface

## License

MIT
