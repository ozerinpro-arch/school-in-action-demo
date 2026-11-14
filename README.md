# School in Action

English edition of the full School in Action workspace. The demo starts with a fictional school, classes, staff, student accounts and a confirmed club charge. It includes the timetable planner, substitutions and a PDF for confirmed club charges.

## Start

Install Docker Engine with the Compose plugin, or Docker Desktop, and start Docker. In the root of the clone run:

```sh
docker compose up --build
```

When the server reports it is running, open [School in Action](http://127.0.0.1:5261/). Use the address shown here, including `127.0.0.1`. The first build downloads pinned dependencies. If port 5261 is in use, run `DEMO_PORT=5262 docker compose up --build` and open [port 5262](http://127.0.0.1:5262/).

The director portal opens directly on your computer. The service is published on loopback. Use the [staff and student sign-in](http://127.0.0.1:5261/school-staff/) for the fictional accounts below. Their shared demo password is `SchoolDemo-2026-Local!`. Separate browser profiles are useful when comparing roles.

| Role | Username |
| --- | --- |
| Director | `demo.director` |
| Planner | `demo.planner` |
| Teacher | `demo.teacher` |
| Substitute teacher | `demo.substitute` |
| Student | `demo.student` |
| Access administrator | `demo.access` |

## Try it

| Workflow | Where to start |
| --- | --- |
| Weekly timetable | Open **Timetable** in the director portal. Filter by class, open a lesson to edit it, or inspect the entire school grid. |
| Daily timetable | Sign in as the planner. Open **Timetable** and the daily plan to check the seeded brief and run the scheduler. |
| Substitution | In the director portal, open **Substitutions**. Pick the Monday Grade 7A mathematics lesson, select Owen Reed and enter a reason. Preview, confirm the draft, then preview and publish the change. Sign in as the substitute to see the published result. |
| Assignments | Jamie Lane can open **My assignments** and submit an answer to **Equivalent fractions**. Sign in as the teacher and open **Assignments and grading** to review it. |
| Clubs and receipts | In the director portal open **Clubs → Charges** and download the seeded Robotics club PDF. New charges get a download after confirmation. Jamie can download their own confirmed PDFs from **Club receipts** in the student workspace. Cancelling a charge withdraws its download. The PDF records the charge and states that no payment was collected. |

`docker compose stop`, `docker compose up -d` and container replacement keep the fictional records in the `school-data` volume. If you want to remove that volume and start with a fresh fictional school, run `docker compose down -v` and then start again.

The **AI and MAX** screen shows their offline status. Historical workflows that depend on school source files are unavailable in this build. The earlier standalone demo is available via `docker compose -f compose.standalone.yaml up --build` on port 5188.

The full edition uses the original Cloud Porcelain interface and an English display dictionary generated with the Helsinki-NLP OPUS-MT Russian–English model (CC BY 4.0), with reviewed UI wording. The font is Inter (SIL Open Font License), and icons are from Lucide (ISC).
