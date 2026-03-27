# @council-of-experts/cli

Interactive CLI chat interface for council-of-experts. Demonstrates the library with a simple command-line application.

## Features

- **Multi-agent chat**: Mention agents with `@AgentName` to invoke them
- **Document collaboration**: Agents can read and edit a shared document
- **Tool system**: Agents have access to document, context, and introspection tools
- **In-memory session**: Ephemeral - no persistence between runs

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Create config file

Copy `config.example.json` to `config.json` and edit:

```json
{
  "models": [
    {
      "name": "local-llm",
      "url": "http://localhost:1234/v1",
      "api_key": "",
      "model": "your-model-name"
    }
  ],
  "agents": [
    {
      "name": "Analyst",
      "icon": "📊",
      "purpose": "Analyzes data and provides insights",
      "system_prompt": "You are an analytical expert...",
      "model": "local-llm",
      "temperature": 0.7
    }
  ]
}
```

### 3. Run the CLI

```bash
npm run dev
```

Or build and run:

```bash
npm run build
npm start
```

## Usage

### Commands

- `@AgentName message` - Mention an agent to invoke them
- `/doc` - View current document
- `/clear` - Clear conversation history
- `/help` - Show help
- `/quit` - Exit

### Example Session

```
> @Writer create a haiku about AI

✍️ Writer:
Silicon minds wake
Patterns dance in digital streams
Wisdom emerges

> @Reviewer what do you think?

🔍 Reviewer:
The haiku captures the essence well. The imagery of "silicon minds"
and "digital streams" effectively conveys the AI theme. Consider if
"wisdom emerges" might be strengthened with a more specific observation.

> /doc
==================================================
CURRENT DOCUMENT:
==================================================
Silicon minds wake
Patterns dance in digital streams
Wisdom emerges
==================================================
```

## Available Tools

Agents have access to these tools:

- **read_document** - Read the current document
- **write_document** - Replace document content
- **list_participants** - See all agents
- **get_context** - View conversation history
- **my_role** - Introspection (who am I?)

## Configuration

### Environment Variables

- `COUNCIL_CONFIG` - Path to config file (default: `./config.json`)

### Config File

See `config.example.json` for full structure:

- `models` - AI model configurations (OpenAI-compatible APIs)
- `agents` - Agent definitions (name, purpose, system prompt, etc.)
- `timeout_ms` - API timeout (default: 60000)
- `verbose` - Enable verbose logging (default: false)
- `initial_document` - Starting document content

## Architecture

The CLI demonstrates clean separation of concerns:

- **Providers** - In-memory implementations of council-of-experts interfaces
- **Tools** - Basic document/context/introspection tools
- **Chat Loop** - Interactive readline interface
- **Config** - JSON-based configuration

This structure shows how to integrate council-of-experts into any application.

## Development

```bash
# Run in dev mode with auto-reload
npm run dev

# Build TypeScript
npm run build

# Run built version
npm start config.json
```

## License

MIT
