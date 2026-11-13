# School in Action

An English-language school operations demo. The school, people, activities and amounts are fictional. The demo runs locally and uses a separate SQLite volume.

## Run locally

Install Docker with the Compose plugin. From the root of the clone, run:

```sh
docker compose up --build
```

Open [http://127.0.0.1:5188](http://127.0.0.1:5188). The first build downloads the base images and pinned dependencies. The server is published on loopback and needs no keys or accounts. The port must be available.

## Try the workflows

| Workflow | Steps |
| --- | --- |
| Weekly schedule | As Director, filter by weekday or class. Add or edit a lesson. The server checks room, teacher and class overlaps. |
| Substitutions | Choose **Teacher · Maya Brooks**, find Monday's **Cell structure** lesson and send a substitution request. As **Director**, approve **Owen Reed** in **Substitutions**. Open Owen's schedule to complete the lesson and Jamie's schedule to see who is covering it. |
| Assignments | As Maya, publish a Biology assignment for **Jamie Lane**. As Jamie, submit an answer. Return to Maya to score it and leave feedback. Read the result in Jamie's Assignments and Grades, and see counts by subject in Progress. |
| Materials and tasks | Teachers can share notes for their scheduled lessons and update their school tasks. Students see their class materials and their own assignment and schedule activity. |
| Clubs | As Director, create or edit a program and manage enrollment. As Jamie, join or leave an active club. For a paid fictional club, preview, draft, confirm or cancel a simulated charge in the director workspace. |
| School overview | As Director, open the directory, approve the example document, view live counts and inspect the activity feed. |

The role selector is intentionally open to everyone with local access. Its fictional sessions expire or end when the container restarts. SQLite changes survive a stop, restart or container replacement. Use **Overview → Reset demo** in the director workspace to restore the original fictional records.

## Integration status

The **Integrations** page lists the disconnected or omitted systems. These include NanoGPT, MAX, real staff/student identity, imports, school data connectors and payment processing. Automated schedule solving, daily planning, live calendar and formal school publication are outside the standalone demo. Schedule edits and substitutions appear directly in the appropriate workspaces. The legacy accountant workspace, receipt PDFs, global search, canned helper, attendance, assignment drafts, discussions and practice activities are outside this demo.

## Verification

Use a disposable demo instance for tests. The browser suite restores the fictional seed when explicitly instructed:

```sh
npm ci --ignore-scripts
npx playwright install chromium
DEMO_E2E_RESET=1 npm run test:e2e
```

GitHub Actions builds the image, runs the browser suite and checks that a fictional edit survives a restart. The build uses React, TypeScript and Vite for the interface, and FastAPI, Uvicorn and SQLite for the server. The base images, Python dependencies and npm dependencies are pinned. The runtime uses local assets and makes no outbound integration requests.

The demo reuses the local project’s session, storage and request-boundary patterns, and its school favicon. The interface uses Inter (SIL Open Font License) and Lucide icons (ISC).
