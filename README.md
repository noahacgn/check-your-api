# check-your-api

Multi-key and multi-endpoint availability checker for OpenAI-compatible APIs with matrix results and real-time latency monitoring.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Z1rconium/check-your-api)

![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?logo=vite&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.21-000000?logo=express&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-Ready-000000?logo=vercel&logoColor=white)

[简体中文](./README.zh-CN.md)

## Overview

`check-your-api` is a web-based tool for validating OpenAI-compatible APIs in two comparison modes: one Base URL with multiple API keys, or one API key with multiple Base URLs. It fetches models per comparison column, merges the model union, then checks the listed `column × model` combinations as a matrix with status, failure reason, and first-token latency feedback.

**Key capabilities:**
- Fetch model lists per API key from any OpenAI-compatible endpoint
- Fetch model lists across multiple Base URLs with one API key
- Merge model lists across keys or endpoints
- `Key/Endpoint × model` matrix testing with configurable total concurrency
- First-token latency measurement for performance insights
- Model selection and filtering for targeted testing
- API keys are not persisted and are cleared on refresh
- Non-sensitive settings are persisted via localStorage

## Technology Stack

**Frontend:**
- React 18.3+ with TypeScript
- Vite 5.4+ for build tooling
- CSS3 with custom properties for theming

**Backend:**
- Node.js 18+ runtime
- Express 4.21+ for development/production server
- Vercel serverless functions for cloud deployment

**Development:**
- TypeScript 5.5+ with strict type checking
- TSX for development hot-reload
- Concurrently for parallel dev processes

## Architecture

The application uses a proxy architecture to avoid CORS issues:

```
Browser → Frontend (React)
    ↓
    /api/models or /api/check
    ↓
Backend Proxy Layer (Express or Vercel Functions)
    ↓
Target OpenAI-compatible API
```

**Core components:**
- `src/App.tsx` - Main React application with state management
- `server/core.ts` - Shared request handling logic
- `server/app.ts` - Express server for Node.js deployment
- `api/*.ts` - Vercel serverless function handlers

**Request flow:**
1. User chooses a mode: multi-key or multi-Base-URL
2. Frontend calls `/api/models` once per key or once per Base URL
3. Frontend merges the union of all successfully returned models
4. User selects models and starts the batch check
5. Frontend expands the listed `column × model` task matrix and calls `/api/check` with total concurrency control
6. Backend proxies streaming requests to the target API
7. Each cell displays availability, first-token latency, and failure reason

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm package manager
- Valid OpenAI-compatible API endpoint and key

### Installation

```bash
npm install
```

### Development Mode

Run both frontend and backend in watch mode:

```bash
npm run dev
```

Access the application at:
- Frontend: `http://127.0.0.1:5173`
- Backend proxy: `http://127.0.0.1:8787`

### Production Build

Build the application:

```bash
npm run build
```

Start the production server:

```bash
npm run start
```

Override the default port if needed:

```bash
PORT=3000 npm run start
```

## Deployment

### Vercel (Recommended)

This project is optimized for Vercel deployment. The recommended path is importing your fork from the Vercel Dashboard:

1. Push your changes to your GitHub fork.
2. In Vercel Dashboard, choose **Add New Project**.
3. Import this GitHub repository.
4. Keep the default build command `npm run build` and output directory `dist`.
5. After deployment, smoke test model fetching and matrix checking on the production URL.

You can also use the Vercel CLI:

```bash
vercel
```

Or click the "Deploy with Vercel" button above to deploy directly from GitHub.

The `vercel.json` configuration automatically:
- Builds the Vite frontend to `dist/`
- Exposes `/api/models` and `/api/check` as serverless functions
- Serves static assets from the build output

The free Hobby plan has function invocation, duration, and resource limits. Matrix scheduling runs in the browser so each serverless invocation stays atomic. Start with total concurrency 3-5, and narrow the selected models before checking large matrices.

### Self-Hosted

Build and run on any Node.js-compatible server:

```bash
npm run build
npm run start
```

The server listens on port 8787 by default (configurable via `PORT` environment variable).

## Project Structure

```
.
├── api/                    # Vercel serverless functions
│   ├── check.ts           # Model availability check endpoint
│   └── models.ts          # Model list fetch endpoint
├── server/                # Node.js server implementation
│   ├── core.ts           # Shared request handling logic
│   ├── app.ts            # Express application setup
│   └── index.ts          # Server entry point
├── src/                   # React frontend
│   ├── App.tsx           # Main application component
│   ├── main.tsx          # React entry point
│   └── styles.css        # Application styles
├── vite.config.ts        # Vite build configuration
├── vercel.json           # Vercel deployment config
└── package.json          # Dependencies and scripts
```

## Key Features

### Probe Modes
Use **multi-key mode** to compare several API keys under the same Base URL. Use **multi-Base-URL mode** to compare several compatible endpoints with one API key.

### Multi-key Model Discovery
Calls the configured endpoint's `/models` endpoint once per API key, then merges the union of all successfully returned models. A failed key does not block other keys from contributing models.

### Multi-endpoint Model Discovery
Calls each configured Base URL's `/models` endpoint with the same API key, then merges the union of all successfully returned models. A failed endpoint does not block other endpoints from contributing models.

### Selective Testing
Choose which models to test using the model picker with search and bulk selection controls. The picker is based on the model union across keys or endpoints.

### Matrix Checking
Checks only combinations that were listed by that key or endpoint's `/models` response. If a selected model is not listed for a column, that cell is marked as skipped and no `/api/check` request is sent for it.

### Total Concurrency Control
Configure total concurrency (1-N parallel requests) to balance speed against Vercel Hobby limits and upstream rate limits.

### Performance Metrics
Displays first-token latency for available models, color-coded by response speed:
- **Fast**: ≤800ms
- **Medium**: 801-2000ms
- **Slow**: >2000ms

### Result Filtering
Filter results by status: All, Available, Unavailable, or Pending.

### Custom Prompts
Use consistent test prompts across all models for comparable results.

### Non-sensitive Form Persistence
Base URL inputs, selected mode, concurrency, and prompt are saved to browser localStorage. API keys are not written to localStorage and are not stored, cached, or aggregated by the server.

## API Compatibility

This tool expects the target service to implement:

- `GET {baseUrl}/models` - Returns list of available models
- `POST {baseUrl}/chat/completions` - Accepts chat completion requests with streaming

**Compatible services:**
- OpenAI API (`https://api.openai.com/v1`)
- Azure OpenAI Service
- OpenRouter
- Any OpenAI-compatible proxy or gateway

**Probe request format:**
```json
{
  "model": "model-id",
  "messages": [{"role": "user", "content": "Hi"}],
  "stream": true,
  "temperature": 0,
  "max_tokens": 64
}
```

## Usage Notes

- **Concurrency**: Higher values test faster but may trigger rate limits. Start with 3-5.
- **Security**: API keys only live in current page memory. They are sent only to this app's proxy and the target upstream API during requests.
- **Availability**: A model appearing in `/models` doesn't guarantee it's callable.
- **Matrix semantics**: `Not listed in /models` means the key or endpoint omitted that model. The cell is skipped and no probe is executed for that combination.
- **Latency**: First-token latency measures time to first streamed response chunk.
- **Timeout**: Requests timeout after 30 seconds.
- **Vercel Hobby**: Listed key/endpoint-model combinations determine the task count. The UI warns above 100 tasks but does not block advanced users.

## Development

### Scripts

- `npm run dev` - Start development mode (frontend + backend)
- `npm run dev:web` - Start Vite dev server only
- `npm run dev:proxy` - Start Express proxy server only
- `npm run build` - Build for production
- `npm run build:web` - Build frontend only
- `npm run build:server` - Build backend only
- `npm run start` - Start production server
- `npm run preview` - Preview production build locally

### Feature Notes

The matrix behavior contract is documented in [`docs/multi-key-probe.md`](./docs/multi-key-probe.md).

### TypeScript Configuration

The project uses TypeScript project references:
- `tsconfig.app.json` - Frontend configuration
- `tsconfig.node.json` - Vite config types
- `tsconfig.server.json` - Backend server types

## Roadmap

- [ ] Export results as CSV or JSON
- [ ] Display detailed error messages for failures
- [ ] Add retry logic and rate-limit handling
- [ ] Support additional probe types (embeddings, completions)
- [ ] Model comparison view
- [ ] Historical latency tracking

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

No license file has been added yet. Please contact the repository owner for licensing information.

## Acknowledgments

Built with React, Vite, Express, and TypeScript. Designed for developers working with OpenAI-compatible APIs.
